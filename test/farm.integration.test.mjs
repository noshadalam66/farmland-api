import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { FarmStore } from '../dist/farm.js';

test('farm commands preserve progress across sessions and retries', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a test database with migrations 000002 and 000005–000010.');
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const playerUid = randomUUID();
  const otherUid = randomUUID();
  const app = createApp({
    store: new FarmStore(pool),
    verifyToken: async (token) => {
      if (token === 'android' || token === 'ios' || token === 'web') return { uid: playerUid };
      if (token === 'other') return { uid: otherUid };
      throw new Error('Invalid token');
    },
  }, 'https://farm.example');
  t.after(async () => {
    try {
      await app.close();
      await pool.query('DELETE FROM starter_farms WHERE player_uid = ANY($1)', [[playerUid, otherUid]]);
    } finally {
      await pool.end();
    }
  });

  const load = (token) => app.inject({
    method: 'GET', url: '/v1/farm', headers: { authorization: `Bearer ${token}` },
  });
  const submit = (token, payload) => app.inject({
    method: 'POST', url: '/v1/farm/commands', headers: { authorization: `Bearer ${token}` }, payload,
  });

  assert.equal((await app.inject('/healthz')).statusCode, 200);
  assert.equal((await load('invalid')).statusCode, 401);
  const preflight = await app.inject({
    method: 'OPTIONS',
    url: '/v1/farm/commands',
    headers: {
      origin: 'https://farm.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://farm.example');

  const initial = (await load('android')).json();
  assert.equal(initial.revision, 0);
  assert.equal(initial.plot, null);
  const plant = { commandId: randomUUID(), expectedRevision: 0, action: 'plant' };
  assert.equal((await submit('android', { ...plant, expectedRevision: '0' })).statusCode, 400);
  const planted = await submit('android', plant);
  assert.equal(planted.statusCode, 200);
  const plantState = planted.json();
  const browserState = (await load('web')).json();
  assert.equal(browserState.revision, 1);
  assert.deepEqual(browserState.plot, plantState.plot);
  assert.equal(Date.parse(browserState.plot.readyAt) - Date.parse(browserState.plot.plantedAt), 60_000);
  assert.equal((await load('other')).json().revision, 0);
  assert.equal((await submit('ios', { ...plant, action: 'harvest' })).json().code, 'command_id_reused');

  const harvest = { commandId: randomUUID(), expectedRevision: 1, action: 'harvest' };
  assert.equal((await submit('ios', harvest)).json().code, 'crop_not_ready');
  // Advance the stored timer so the test can exercise harvest without waiting a minute.
  await pool.query(
    `UPDATE starter_farms SET planted_at = now() - interval '61 seconds',
     ready_at = now() - interval '1 second' WHERE player_uid = $1`,
    [playerUid],
  );

  const harvestCommands = [harvest, { ...harvest, commandId: randomUUID() }];
  const attempts = await Promise.all([
    submit('ios', harvestCommands[0]),
    submit('web', harvestCommands[1]),
  ]);
  assert.deepEqual(attempts.map((response) => response.statusCode).sort(), [200, 409]);
  const winnerIndex = attempts.findIndex((response) => response.statusCode === 200);
  assert.equal(attempts[1 - winnerIndex].json().code, 'stale_revision');
  const harvested = attempts[winnerIndex].json();
  assert.equal(harvested.inventory.wheat, 1);
  assert.equal(harvested.plot, null);
  assert.deepEqual((await submit('web', harvestCommands[winnerIndex])).json(), harvested);
  assert.deepEqual((await submit('android', plant)).json(), plantState);

  const final = (await load('android')).json();
  assert.equal(final.revision, 2);
  assert.deepEqual(final.inventory, { wheat: 1, corn: 0, rice: 0, milk: 0, eggs: 0 });
  assert.equal(final.plot, null);

  let revision = final.revision;
  for (const [crop, duration] of [['corn', 90_000], ['rice', 120_000]]) {
    const plantCrop = { commandId: randomUUID(), expectedRevision: revision, action: 'plant', crop };
    const plantedCrop = await submit('android', plantCrop);
    assert.equal(plantedCrop.statusCode, 200);
    const current = plantedCrop.json();
    assert.equal(current.plot.crop, crop);
    assert.equal(Date.parse(current.plot.readyAt) - Date.parse(current.plot.plantedAt), duration);
    assert.deepEqual((await load('web')).json().plot, current.plot);

    const reused = await submit('web', { ...plantCrop, crop: 'wheat' });
    assert.equal(reused.statusCode, 409);
    assert.equal(reused.json().code, 'command_id_reused');

    const harvestCrop = { commandId: randomUUID(), expectedRevision: current.revision, action: 'harvest' };
    assert.equal((await submit('ios', { ...harvestCrop, crop })).statusCode, 400);
    assert.equal((await submit('ios', harvestCrop)).json().code, 'crop_not_ready');
    await pool.query(
      `UPDATE starter_farms SET planted_at = now() - interval '2 seconds',
       ready_at = now() - interval '1 second' WHERE player_uid = $1`,
      [playerUid],
    );
    const collected = await submit('ios', harvestCrop);
    assert.equal(collected.statusCode, 200);
    assert.equal(collected.json().inventory[crop], 1);
    assert.deepEqual((await submit('android', harvestCrop)).json(), collected.json());
    revision = collected.json().revision;
  }
  assert.deepEqual((await load('android')).json().inventory, { wheat: 1, corn: 1, rice: 1, milk: 0, eggs: 0 });

  const legacyReceipt = { ...plantState, inventory: { wheat: 0 },
    plot: { plantedAt: plantState.plot.plantedAt, readyAt: plantState.plot.readyAt } };
  await pool.query(
    'UPDATE starter_farm_commands SET crop = NULL, response = $3 WHERE player_uid = $1 AND command_id = $2',
    [playerUid, plant.commandId, legacyReceipt],
  );
  const legacyReplay = await submit('web', { ...plant, crop: 'wheat' });
  assert.equal(legacyReplay.statusCode, 200);
  assert.equal(legacyReplay.json().plot.crop, 'wheat');
  assert.deepEqual(legacyReplay.json().inventory, { wheat: 0, corn: 0, rice: 0, milk: 0, eggs: 0 });

  const newPlant = await submit('android', {
    commandId: randomUUID(), expectedRevision: revision, action: 'plant', crop: 'rice',
  });
  assert.equal(newPlant.statusCode, 200);
  const stocked = newPlant.json();
  const sale = { commandId: randomUUID(), expectedRevision: stocked.revision, action: 'sell', crop: 'corn' };
  assert.equal((await submit('android', { ...sale, crop: undefined })).statusCode, 400);
  assert.equal((await submit('android', { ...sale, price: 1000 })).statusCode, 400);

  const saleAttempt = await Promise.all([submit('android', sale), submit('web', sale)]);
  for (const response of saleAttempt) assert.equal(response.statusCode, 200);
  const sold = saleAttempt[0].json();
  assert.deepEqual(sold, saleAttempt[1].json());
  assert.equal(sold.wallet.coins, sold.market.sellPrices.corn);
  assert.equal(sold.inventory.corn, 0);
  assert.deepEqual(sold.plot, stocked.plot);

  const rejectedSale = await submit('web', { ...sale, commandId: randomUUID(), expectedRevision: sold.revision });
  assert.equal(rejectedSale.statusCode, 409);
  assert.equal(rejectedSale.json().code, 'insufficient_crop');
  assert.deepEqual((await load('ios')).json().wallet, sold.wallet);
  const ledger = await pool.query('SELECT coin_delta, balance_after, reason FROM farm_wallet_entries WHERE player_uid = $1', [playerUid]);
  assert.deepEqual(ledger.rows, [{ coin_delta: sold.wallet.coins, balance_after: sold.wallet.coins, reason: 'crop_sale' }]);

  const buy = { commandId: randomUUID(), expectedRevision: sold.revision, action: 'buy_parcel' };
  assert.equal((await submit('android', buy)).json().code, 'insufficient_coins');
  const expandedPlant = { commandId: randomUUID(), expectedRevision: sold.revision,
    action: 'plant', crop: 'corn', plotId: 'expansion' };
  assert.equal((await submit('web', expandedPlant)).json().code, 'parcel_not_owned');

  const riceSale = await submit('web', { ...sale, commandId: randomUUID(), expectedRevision: sold.revision, crop: 'rice' });
  const savings = riceSale.json();
  const purchase = { ...buy, expectedRevision: savings.revision };
  const purchases = await Promise.all([submit('android', purchase), submit('ios', purchase)]);
  assert.deepEqual(purchases.map((response) => response.statusCode), [200, 200]);
  const expanded = purchases[0].json();
  assert.deepEqual(expanded, purchases[1].json());
  assert.equal(expanded.expansion.owned, true);
  assert.equal(expanded.expansion.plot, null);
  assert.equal(expanded.wallet.coins, savings.wallet.coins - expanded.expansion.price);
  assert.equal((await submit('web', {
    ...purchase, commandId: randomUUID(), expectedRevision: expanded.revision,
  })).json().code, 'parcel_already_owned');
  const debits = await pool.query(
    "SELECT coin_delta FROM farm_wallet_entries WHERE player_uid = $1 AND reason = 'parcel_purchase'", [playerUid],
  );
  assert.deepEqual(debits.rows, [{ coin_delta: -expanded.expansion.price }]);

  const plantExpansion = { ...expandedPlant, expectedRevision: expanded.revision };
  const expandedCrop = await submit('ios', plantExpansion);
  assert.equal(expandedCrop.statusCode, 200);
  assert.equal(expandedCrop.json().expansion.plot.crop, 'corn');
  assert.deepEqual(expandedCrop.json().plot, expanded.plot);
  assert.equal((await submit('web', { ...plantExpansion, plotId: 'starter' })).json().code, 'command_id_reused');

  await pool.query(
    `UPDATE farm_expansion_plots SET planted_at = now() - interval '2 seconds',
     ready_at = now() - interval '1 second' WHERE player_uid = $1`, [playerUid],
  );
  const harvestExpansion = await submit('web', { commandId: randomUUID(), expectedRevision: expandedCrop.json().revision,
    action: 'harvest', plotId: 'expansion' });
  assert.equal(harvestExpansion.statusCode, 200);
  assert.equal(harvestExpansion.json().inventory.corn, 1);
  assert.equal(harvestExpansion.json().expansion.plot, null);
  assert.deepEqual(harvestExpansion.json().plot, expanded.plot);


  const postHarvest = harvestExpansion.json();
  const buyChicken = { commandId: randomUUID(), expectedRevision: postHarvest.revision,
    action: 'buy_animal', species: 'chicken' };
  assert.equal((await submit('android', { ...buyChicken, species: 'cow' })).statusCode, 400);
  assert.equal((await submit('android', { ...buyChicken, price: 0 })).statusCode, 400);
  const soldCorn = await submit('android', { commandId: randomUUID(), expectedRevision: postHarvest.revision,
    action: 'sell', crop: 'corn' });
  const available = soldCorn.json();
  const purchaseAnimal = { ...buyChicken, expectedRevision: available.revision };
  const livestockPurchase = await Promise.all([submit('android', purchaseAnimal), submit('web', purchaseAnimal)]);
  assert.deepEqual(livestockPurchase.map((response) => response.statusCode), [200, 200]);
  const animalState = livestockPurchase[0].json();
  assert.deepEqual(livestockPurchase[1].json(), animalState);
  assert.equal(animalState.livestock.animals.length, 1);
  assert.equal(animalState.livestock.animals[0].species, 'chicken');
  assert.equal(animalState.wallet.coins, available.wallet.coins - available.livestock.prices.chicken);
  assert.deepEqual((await load('ios')).json().livestock, animalState.livestock);
  assert.deepEqual((await load('other')).json().livestock.animals, []);

  const goat = { commandId: randomUUID(), expectedRevision: animalState.revision, action: 'buy_animal', species: 'goat' };
  assert.equal((await submit('ios', goat)).json().code, 'insufficient_coins');
  await pool.query('UPDATE starter_farms SET coins = $2 WHERE player_uid = $1', [playerUid, animalState.livestock.prices.goat]);
  const goats = await submit('ios', goat);
  assert.equal(goats.statusCode, 200);
  assert.deepEqual(goats.json().livestock.animals.map((animal) => animal.species), ['chicken', 'goat']);

  const animalDebits = await pool.query(
    "SELECT coin_delta FROM farm_wallet_entries WHERE player_uid = $1 AND reason = 'animal_purchase' ORDER BY coin_delta",
    [playerUid],
  );
  assert.deepEqual(animalDebits.rows, [{ coin_delta: -12 }, { coin_delta: -6 }]);

  const roster = goats.json();
  const chickenId = roster.livestock.animals[0].animalId;
  const goatId = roster.livestock.animals[1].animalId;
  const feed = { commandId: randomUUID(), expectedRevision: roster.revision, action: 'feed_animal', animalId: chickenId };
  assert.equal((await submit('web', { ...feed, animalId: randomUUID() })).json().code, 'animal_not_owned');
  assert.equal((await submit('web', { ...feed, animalId: 'invalid' })).statusCode, 400);
  const fedChicken = await submit('android', feed);
  assert.equal(fedChicken.statusCode, 200);
  const feeding = fedChicken.json();
  assert.equal(feeding.inventory.wheat, roster.inventory.wheat - 1);
  assert.equal(Date.parse(feeding.livestock.animals[0].productReadyAt) - Date.parse(feeding.serverTime), 60_000);
  assert.deepEqual((await submit('web', feed)).json(), feeding);
  assert.deepEqual((await load('ios')).json().livestock, feeding.livestock);
  const collect = { ...feed, commandId: randomUUID(), expectedRevision: feeding.revision, action: 'collect_animal' };
  assert.equal((await submit('ios', collect)).json().code, 'product_not_ready');
  assert.equal((await submit('ios', { ...feed, commandId: randomUUID(), expectedRevision: feeding.revision })).json().code,
    'animal_already_fed');

  await pool.query("UPDATE farm_animals SET product_ready_at = now() - interval '1 second' WHERE animal_id = $1", [chickenId]);
  const eggs = await submit('ios', collect);
  assert.equal(eggs.statusCode, 200);
  assert.equal(eggs.json().inventory.eggs, 1);
  assert.equal(eggs.json().livestock.animals[0].productReadyAt, null);
  assert.deepEqual((await submit('android', collect)).json(), eggs.json());

  const feedGoat = { ...feed, commandId: randomUUID(), expectedRevision: eggs.json().revision, animalId: goatId };
  assert.equal((await submit('web', feedGoat)).json().code, 'insufficient_crop');
  await pool.query('UPDATE starter_farms SET wheat = 1 WHERE player_uid = $1', [playerUid]);
  const fedGoat = await submit('web', feedGoat);
  assert.equal(fedGoat.statusCode, 200);
  assert.equal(Date.parse(fedGoat.json().livestock.animals[1].productReadyAt) - Date.parse(fedGoat.json().serverTime), 90_000);
  await pool.query("UPDATE farm_animals SET product_ready_at = now() - interval '1 second' WHERE animal_id = $1", [goatId]);
  const milk = await submit('android', { ...collect, commandId: randomUUID(), expectedRevision: fedGoat.json().revision, animalId: goatId });
  assert.equal(milk.statusCode, 200);
  assert.equal(milk.json().inventory.milk, 1);
  assert.equal(milk.json().inventory.eggs, 1);

  const milkState = milk.json();
  await pool.query('UPDATE starter_farms SET coins = 6 WHERE player_uid = $1', [playerUid]);
  const secondChicken = await submit('web', { ...buyChicken, commandId: randomUUID(), expectedRevision: milkState.revision });
  assert.equal(secondChicken.statusCode, 200);
  const pair = secondChicken.json();
  const father = pair.livestock.animals[2];
  assert.equal(father.sex, 'male');
  assert.equal(pair.livestock.animals[0].sex, 'female');

  const breed = { commandId: randomUUID(), expectedRevision: pair.revision, action: 'start_breeding',
    animalId: chickenId, partnerId: father.animalId };
  assert.equal((await submit('ios', { ...breed, partnerId: goatId })).json().code, 'invalid_breeding_pair');
  assert.equal((await submit('ios', { ...breed, partnerId: chickenId })).json().code, 'invalid_breeding_pair');
  const breeding = await submit('ios', breed);
  assert.equal(breeding.statusCode, 200);
  const pendingBreeding = breeding.json().livestock.breeding;
  assert.equal(pendingBreeding.motherId, chickenId);
  assert.equal(pendingBreeding.fatherId, father.animalId);
  assert.equal(Date.parse(pendingBreeding.readyAt) - Date.parse(breeding.json().serverTime), 180_000);
  assert.deepEqual((await load('web')).json().livestock.breeding, pendingBreeding);

  const collectOffspring = { commandId: randomUUID(), expectedRevision: breeding.json().revision, action: 'collect_offspring' };
  assert.equal((await submit('web', collectOffspring)).json().code, 'offspring_not_ready');
  await pool.query("UPDATE farm_breeding SET ready_at = now() - interval '1 second' WHERE player_uid = $1", [playerUid]);
  const births = await Promise.all([submit('web', collectOffspring), submit('android', collectOffspring)]);
  assert.equal(births[0].statusCode, 200);
  assert.equal(births[1].statusCode, 200);
  const birth = births[0].json();
  assert.deepEqual(births[1].json(), birth);
  assert.equal(birth.livestock.animals.length, 4);
  assert.equal(birth.livestock.breeding, null);
  const chick = birth.livestock.animals[3];
  assert.equal(chick.motherId, chickenId);
  assert.equal(chick.fatherId, father.animalId);
  assert.equal(Date.parse(chick.matureAt) - Date.parse(birth.serverTime), 120_000);
  assert.deepEqual((await load('ios')).json().livestock, birth.livestock);
  const relatedPair = { ...breed, commandId: randomUUID(), expectedRevision: birth.revision,
    animalId: chick.animalId, partnerId: chick.sex === 'female' ? father.animalId : chickenId };
  assert.equal((await submit('web', relatedPair)).json().code, 'invalid_breeding_pair');
  await pool.query("UPDATE farm_animals SET mature_at = now() - interval '1 second' WHERE animal_id = $1", [chick.animalId]);
  assert.equal((await submit('web', relatedPair)).json().code, 'invalid_breeding_pair');

});

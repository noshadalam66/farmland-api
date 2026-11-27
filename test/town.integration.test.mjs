import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { FarmStore } from '../dist/farm.js';

test('town buildings charge once and residents arrive from server time', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a test database with migrations 000013–000015.');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const uid = randomUUID();
  const other = randomUUID();
  const app = createApp({
    store: new FarmStore(pool),
    verifyToken: async (token) => ({ uid: token === 'other' ? other : uid }),
  });
  t.after(async () => {
    try {
      await app.close();
      await pool.query('DELETE FROM starter_farms WHERE player_uid = ANY($1)', [[uid, other]]);
    } finally {
      await pool.end();
    }
  });

  const send = (command, token = 'first') => app.inject({
    method: 'POST', url: '/v1/farm/commands',
    headers: { authorization: `Bearer ${token}` }, payload: command,
  });
  const load = (token) => app.inject({ url: '/v1/farm', headers: { authorization: `Bearer ${token}` } });
  const command = (expectedRevision, action, building) => ({
    commandId: randomUUID(), expectedRevision, action, ...(building ? { building } : {}),
  });

  assert.equal((await send(command(0, 'build_town', 'road'))).json().code, 'town_requires_expansion');
  await pool.query('UPDATE starter_farms SET coins = 60 WHERE player_uid = $1', [uid]);
  const expansion = (await send(command(0, 'buy_parcel'))).json();
  assert.equal(expansion.expansion.owned, true);
  assert.equal((await send(command(expansion.revision, 'build_town', 'cottage'))).json().code, 'town_requires_road');
  assert.equal((await send(command(expansion.revision, 'build_town', 'castle'))).statusCode, 400);
  assert.equal((await send({ ...command(expansion.revision, 'build_town', 'road'), price: 0 })).statusCode, 400);

  assert.equal((await send(command(expansion.revision, 'build_town', 'water_tower'))).json().code, 'town_requires_road');
  const road = await send(command(expansion.revision, 'build_town', 'road'));
  assert.equal(road.statusCode, 200);
  const connected = road.json();
  assert.equal(connected.town.buildings[0].kind, 'road');
  assert.equal((await send(command(connected.revision, 'build_town', 'road'))).json().code, 'town_building_limit');

  assert.equal((await send(command(connected.revision, 'build_town', 'workshop'))).json().code, 'town_requires_cottage');
  const buy = command(connected.revision, 'build_town', 'cottage');
  const attempts = await Promise.all([send(buy), send(buy, 'second')]);
  assert.ok(attempts.every((response) => response.statusCode === 200));
  const built = attempts[0].json();
  assert.deepEqual(attempts[1].json(), built);
  assert.equal(built.wallet.coins, connected.wallet.coins - connected.town.catalog.cottage.price);
  assert.equal(built.town.housingCapacity, 3);
  assert.equal(built.town.residents, 0);
  assert.equal(built.town.buildings.length, 2);
  assert.equal((await send({ ...buy, building: 'road' })).json().code, 'command_id_reused');

  await pool.query("UPDATE farm_town_buildings SET built_at = now() - interval '125 seconds' WHERE player_uid = $1 AND kind = 'cottage'", [uid]);
  assert.equal((await load('second')).json().town.residents, 2);
  assert.equal((await load('other')).json().town.buildings.length, 0);
  await pool.query("UPDATE farm_town_buildings SET built_at = now() - interval '24 hours' WHERE player_uid = $1 AND kind = 'cottage'", [uid]);
  assert.equal((await load('first')).json().town.residents, 3);
  const ledger = await pool.query(
    "SELECT coin_delta FROM farm_wallet_entries WHERE player_uid = $1 AND reason = 'town_construction' ORDER BY coin_delta",
    [uid],
  );
  assert.deepEqual(ledger.rows, [{ coin_delta: -12 }, { coin_delta: -6 }]);
  await pool.query('UPDATE starter_farms SET coins = 100 WHERE player_uid = $1', [uid]);
  let current = (await load('first')).json();
  for (const kind of ['cottage', 'water_tower', 'workshop', 'school', 'clinic']) {
    const response = await send(command(current.revision, 'build_town', kind));
    assert.equal(response.statusCode, 200, kind);
    current = response.json();
  }
  assert.equal(current.town.housingCapacity, 6);
  assert.equal((await send(command(current.revision, 'build_town', 'water_tower'))).json().code, 'town_building_limit');
  await pool.query("UPDATE farm_town_buildings SET built_at = now() - interval '24 hours' WHERE player_uid = $1 AND kind = 'cottage'", [uid]);
  const grown = (await load('second')).json();
  assert.equal(grown.town.residents, 6);
  assert.deepEqual(grown.town.capacities, { water: 12, jobs: 4, education: 6, health: 8 });
  assert.deepEqual(grown.town.served, { water: 6, jobs: 4, education: 6, health: 6 });
  assert.equal(grown.town.wellbeing, 95);
  assert.deepEqual((await load('other')).json().town.served, { water: 0, jobs: 0, education: 0, health: 0 });

  const order = { commandId: randomUUID(), expectedRevision: grown.revision, action: 'fulfil_town_order',
    orderKey: 'wheat_supply', orderDate: grown.townOrders.date };
  assert.equal((await send({ ...order, orderDate: '2000-01-01' })).json().code, 'town_order_expired');
  assert.equal((await send({ ...order, reward: 1000 })).statusCode, 400);
  assert.equal((await send({ ...order, expectedRevision: 0 }, 'other')).json().code, 'town_order_locked');
  assert.equal((await send(order)).json().code, 'town_order_stock');

  await pool.query('UPDATE starter_farms SET wheat = 4, milk = 1, flour = 1 WHERE player_uid = $1', [uid]);
  const results = await Promise.all([send(order), send(order, 'second')]);
  assert.deepEqual(results.map((response) => response.statusCode), [200, 200]);
  assert.deepEqual(results[0].json(), results[1].json());
  const fulfilled = results[0].json();
  assert.equal(fulfilled.wallet.coins, grown.wallet.coins + 8);
  assert.equal(fulfilled.inventory.wheat, 2);
  assert.equal(fulfilled.townOrders.offers[0].fulfilled, true);
  assert.equal((await send({ ...order, commandId: randomUUID(), expectedRevision: fulfilled.revision })).json().code,
    'town_order_fulfilled');
  assert.equal((await load('second')).json().townOrders.offers[0].fulfilled, true);
  assert.equal((await load('other')).json().townOrders.offers[0].fulfilled, false);

  let next = fulfilled;
  for (const [orderKey, item, reward] of [['flour_supply', 'flour', 12], ['milk_supply', 'milk', 10]]) {
    const response = await send({ ...order, orderKey, commandId: randomUUID(), expectedRevision: next.revision });
    assert.equal(response.statusCode, 200);
    const state = response.json();
    assert.equal(state.inventory[item], 0);
    assert.equal(state.wallet.coins, next.wallet.coins + reward);
    next = state;
  }
  const orderCredits = await pool.query(
    "SELECT coin_delta FROM farm_wallet_entries WHERE player_uid = $1 AND reason = 'town_order' ORDER BY coin_delta", [uid],
  );
  assert.deepEqual(orderCredits.rows, [{ coin_delta: 8 }, { coin_delta: 10 }, { coin_delta: 12 }]);

});

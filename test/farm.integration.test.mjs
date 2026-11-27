import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { FarmStore } from '../dist/farm.js';

test('farm commands preserve progress across sessions and retries', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a test database with migrations 000002 and 000005.');
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
  assert.deepEqual(final.inventory, { wheat: 1, corn: 0, rice: 0 });
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
  assert.deepEqual((await load('android')).json().inventory, { wheat: 1, corn: 1, rice: 1 });

  const legacyReceipt = { ...plantState, inventory: { wheat: 0 },
    plot: { plantedAt: plantState.plot.plantedAt, readyAt: plantState.plot.readyAt } };
  await pool.query(
    'UPDATE starter_farm_commands SET crop = NULL, response = $3 WHERE player_uid = $1 AND command_id = $2',
    [playerUid, plant.commandId, legacyReceipt],
  );
  const legacyReplay = await submit('web', { ...plant, crop: 'wheat' });
  assert.equal(legacyReplay.statusCode, 200);
  assert.equal(legacyReplay.json().plot.crop, 'wheat');
  assert.deepEqual(legacyReplay.json().inventory, { wheat: 0, corn: 0, rice: 0 });

});

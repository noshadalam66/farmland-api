import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { FarmStore } from '../dist/farm.js';
import { WorldStore } from '../dist/world.js';

test('world selection is private, bounded, and safe to retry', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a test database with migrations 000002 and 000003.');
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const playerUid = randomUUID();
  const otherUid = randomUUID();
  const app = createApp({
    store: new FarmStore(pool),
    worldStore: new WorldStore(pool),
    verifyToken: async (token) => {
      if (token === 'same-account') return { uid: playerUid };
      if (token === 'other-account') return { uid: otherUid };
      throw new Error('Invalid token');
    },
  });
  t.after(async () => {
    try {
      await app.close();
      await pool.query('DELETE FROM world_requests WHERE player_uid = ANY($1)', [[playerUid, otherUid]]);
    } finally {
      await pool.end();
    }
  });

  const request = (token, payload) => app.inject({
    method: payload ? 'POST' : 'GET',
    url: '/v1/world',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
  assert.equal((await request('invalid')).statusCode, 401);
  assert.equal((await request('same-account')).statusCode, 404);

  const selection = { requestId: randomUUID(), latitude: 25.29, longitude: 51.53, areaKm2: 4 };
  for (const invalid of [
    { latitude: 81 },
    { longitude: 180 },
    { areaKm2: 2 },
    { latitude: '25.29' },
    { worldId: randomUUID() },
  ]) {
    assert.equal((await request('same-account', { ...selection, ...invalid })).statusCode, 400);
  }

  const firstAttempts = await Promise.all([
    request('same-account', selection),
    request('same-account', selection),
  ]);
  assert.deepEqual(firstAttempts.map((response) => response.statusCode).sort(), [200, 201]);
  const world = firstAttempts[0].json();
  assert.equal(world.status, 'queued');
  assert.equal(world.areaKm2, 4);
  assert.match(world.worldId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(firstAttempts[1].json(), world);
  assert.deepEqual((await request('same-account')).json(), world);
  assert.equal((await request('other-account')).statusCode, 404);

  const reused = await request('same-account', { ...selection, areaKm2: 9 });
  assert.equal(reused.statusCode, 409);
  assert.equal(reused.json().code, 'request_id_reused');
  const secondWorld = await request('same-account', { ...selection, requestId: randomUUID() });
  assert.equal(secondWorld.statusCode, 409);
  assert.equal(secondWorld.json().code, 'world_already_exists');
});

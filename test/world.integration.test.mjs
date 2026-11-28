import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { FarmStore } from '../dist/farm.js';
import { WorldStore } from '../dist/world.js';
import { processTerrainJob } from '../dist/terrain-job.js';

test('world selection is private, bounded, and safe to retry', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a test database with migrations 000002 through 000004.');
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

  const replacement = {
    ...selection, requestId: randomUUID(), replaceFailedRequestId: selection.requestId,
    latitude: 37.77, longitude: -122.42,
  };
  assert.equal((await request('same-account', replacement)).statusCode, 409);
  assert.equal((await request('other-account', replacement)).statusCode, 409);
  await pool.query(
    "UPDATE world_requests SET status = 'failed', failure_code = 'terrain_export_failed' WHERE player_uid = $1",
    [playerUid],
  );
  assert.equal((await request('same-account', {
    ...replacement, replaceFailedRequestId: randomUUID(),
  })).statusCode, 409);

  const retries = await Promise.all([
    request('same-account', replacement),
    request('same-account', replacement),
  ]);
  assert.deepEqual(retries.map((response) => response.statusCode).sort(), [200, 201]);
  const recovered = retries[0].json();
  assert.deepEqual(retries[1].json(), recovered);
  assert.equal(recovered.worldId, world.worldId);
  assert.equal(recovered.requestId, replacement.requestId);
  assert.equal(recovered.latitude, replacement.latitude);
  assert.equal(recovered.status, 'queued');
  assert.equal(recovered.failureCode, null);
  assert.equal((await request('same-account', selection)).statusCode, 409);
});

test('the terrain worker recovers an expired lease and serves the completed artifact to its owner', async (t) => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), 'farmland-terrain-'));
  const terrainRoot = join(directory, 'terrain');
  const exporter = join(directory, 'exporter.mjs');
  const playerUid = randomUUID();
  const otherUid = randomUUID();
  const store = new WorldStore(pool);
  const app = createApp({
    store: new FarmStore(pool),
    worldStore: store,
    terrainRoot,
    verifyToken: async (uid) => ({ uid }),
  });
  t.after(async () => {
    try {
      await app.close();
      await pool.query('DELETE FROM world_requests WHERE player_uid = ANY($1)', [[playerUid, otherUid]]);
    } finally {
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  });

  await writeFile(exporter, `
    import { mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const path = process.argv[3];
    await mkdir(path);
    await writeFile(join(path, 'manifest.json'), '{"version":1}');
    await writeFile(join(path, 'height-0-0.f32'), Buffer.alloc(33 * 33 * 4));
    if (process.argv.includes('--water-source')) {
      await writeFile(join(path, 'water-0-0.u8'), Buffer.alloc(33 * 33, 1));
    }
  `);
  await store.queue(playerUid, { requestId: randomUUID(), latitude: 25, longitude: 51, areaKm2: 1 });
  await pool.query(
    `UPDATE world_requests SET status = 'generating', lease_id = gen_random_uuid(),
     lease_expires_at = statement_timestamp() - interval '1 second' WHERE player_uid = $1`,
    [playerUid],
  );

  const config = { root: terrainRoot, source: 'fixture', sourceId: 'fixture/1', python: process.execPath, exporter,
    water: { source: 'water-fixture', sourceId: 'water-fixture/1' } };
  const results = await Promise.all([processTerrainJob(pool, config), processTerrainJob(pool, config)]);
  assert.deepEqual(results.sort(), ['idle', 'ready']);

  const get = (uid, path) => app.inject({ url: path, headers: { authorization: `Bearer ${uid}` } });
  assert.equal((await get(playerUid, '/v1/world')).json().status, 'ready');
  assert.deepEqual((await get(playerUid, '/v1/world/terrain/manifest.json')).json(), { version: 1 });
  const chunk = await get(playerUid, '/v1/world/terrain/height-0-0.f32');
  assert.equal(chunk.statusCode, 200);
  assert.equal(chunk.rawPayload.length, 33 * 33 * 4);
  assert.equal((await get(playerUid, '/v1/world/terrain/height-0-1.f32')).statusCode, 404);
  assert.equal((await get(otherUid, '/v1/world/terrain/manifest.json')).statusCode, 404);
  const water = await get(playerUid, '/v1/world/terrain/water-0-0.u8');
  assert.equal(water.statusCode, 200);
  assert.deepEqual(water.rawPayload, Buffer.alloc(33 * 33, 1));
  assert.equal((await get(otherUid, '/v1/world/terrain/water-0-0.u8')).statusCode, 404);

  await store.queue(otherUid, { requestId: randomUUID(), latitude: 0, longitude: 0, areaKm2: 1 });
  assert.equal(await processTerrainJob(pool, { ...config, exporter: join(directory, 'missing.mjs') }), 'failed');
  const failed = (await get(otherUid, '/v1/world')).json();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCode, 'terrain_export_failed');
});

const realSource = process.env.TEST_TERRAIN_SOURCE;
const realWater = process.env.TEST_TERRAIN_WATER_SOURCE;
test('a selected world serves real terrain to a second session of the same account', {
  skip: !realSource || !realWater,
}, async (t) => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const root = await mkdtemp(join(tmpdir(), 'farmland-real-terrain-'));
  const uid = randomUUID();
  const app = createApp({
    store: new FarmStore(pool),
    worldStore: new WorldStore(pool),
    terrainRoot: root,
    verifyToken: async (token) => ({ uid: token === 'other-account' ? randomUUID() : uid }),
  });
  t.after(async () => {
    try {
      await app.close();
      await pool.query('DELETE FROM world_requests WHERE player_uid = $1', [uid]);
    } finally {
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  });

  const selection = { requestId: randomUUID(), latitude: 37.7598, longitude: -122.499, areaKm2: 9 };
  const submitted = await app.inject({
    method: 'POST', url: '/v1/world', payload: selection,
    headers: { authorization: 'Bearer first-session' },
  });
  assert.equal(submitted.statusCode, 201);
  assert.equal(submitted.json().status, 'queued');
  assert.equal(await processTerrainJob(pool, {
    root, source: realSource, sourceId: 'USGS-3DEP',
    python: process.env.TERRAIN_PYTHON ?? 'python3',
    exporter: fileURLToPath(new URL('../workers/terrain/export.py', import.meta.url)),
    water: { source: realWater, sourceId: 'Census-TIGER-2024' },
  }), 'ready');

  const get = (url, token = 'second-session') =>
    app.inject({ url, headers: { authorization: `Bearer ${token}` } });
  const terrain = (name, token) => get('/v1/world/terrain/' + name, token);
  const ready = (await get('/v1/world')).json();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.worldId, submitted.json().worldId);
  const response = await terrain('manifest.json');
  assert.equal(response.statusCode, 200);
  const manifest = response.json();
  assert.deepEqual(manifest.center, { latitude: selection.latitude, longitude: selection.longitude });
  assert.equal(manifest.chunks.length, 9);
  assert.equal(manifest.sourceId, 'USGS-3DEP');
  assert.equal(manifest.waterMask.sourceId, 'Census-TIGER-2024');

  const heights = new Set();
  const waterValues = new Set();
  for (const { file, waterFile } of manifest.chunks) {
    const [height, water] = await Promise.all([terrain(file), terrain(waterFile)]);
    assert.equal(height.statusCode, 200);
    assert.equal(water.statusCode, 200);
    assert.equal(height.rawPayload.length, 33 * 33 * 4);
    assert.equal(water.rawPayload.length, 33 * 33);
    for (let i = 0; i < height.rawPayload.length; i += 4) {
      const value = height.rawPayload.readFloatLE(i);
      assert.ok(Number.isFinite(value));
      heights.add(value);
    }
    for (const value of water.rawPayload) waterValues.add(value);
  }
  assert.ok(heights.size > 1);
  assert.deepEqual(waterValues, new Set([0, 1]));
  assert.equal((await terrain('manifest.json', 'other-account')).statusCode, 404);
});

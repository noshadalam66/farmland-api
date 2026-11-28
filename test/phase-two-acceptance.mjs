import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const { FARM_API_ORIGIN, FARMLAND_ID_TOKEN, FARMLAND_TERRAIN_PACKAGE } = process.env;
const origin = new URL(FARM_API_ORIGIN);
const loopback = ['localhost', '127.0.0.1'].includes(origin.hostname);
assert.ok(origin.protocol === 'https:' || (loopback && origin.protocol === 'http:'));
assert.equal(origin.origin, FARM_API_ORIGIN, 'Use an API origin without a trailing slash or path.');
assert.ok(FARMLAND_ID_TOKEN, 'Set FARMLAND_ID_TOKEN for the acceptance account.');
assert.ok(FARMLAND_TERRAIN_PACKAGE, 'Set FARMLAND_TERRAIN_PACKAGE to a new output directory.');

async function get(path) {
  const response = await fetch(origin.origin + '/v1/world' + path, {
    headers: { authorization: `Bearer ${FARMLAND_ID_TOKEN}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200, path || '/v1/world');
  return response;
}

let world;
for (let attempt = 0; attempt < 60; attempt++) {
  world = await (await get('')).json();
  if (world.status === 'ready') break;
  assert.ok(['queued', 'generating'].includes(world.status), world.failureCode ?? 'Unexpected world state');
  await delay(5000);
}
assert.equal(world?.status, 'ready');
assert.equal(world.areaKm2, 9);
assert.equal(world.latitude, 37.7598);
assert.equal(world.longitude, -122.499);

const manifest = await (await get('/terrain/manifest.json')).text();
const data = JSON.parse(manifest);
assert.equal(data.version, 1);
assert.equal(data.areaKm2, 9);
assert.deepEqual(data.center, { latitude: world.latitude, longitude: world.longitude });
assert.equal(data.chunks.length, 9);
assert.equal(data.encoding, 'float32-le');
assert.equal(data.samplesPerChunkAxis, 33);
assert.equal(data.waterMask.encoding, 'uint8');

const files = new Map([['manifest.json', manifest]]);
for (const { x, y, file, waterFile } of data.chunks) {
  assert.ok(Number.isInteger(x) && x >= 0 && x < 3);
  assert.ok(Number.isInteger(y) && y >= 0 && y < 3);
  assert.equal(file, `height-${x}-${y}.f32`);
  assert.equal(waterFile, `water-${x}-${y}.u8`);
  assert.ok(!files.has(file), 'Duplicate terrain tile.');
  const [height, water] = await Promise.all(
    [file, waterFile].map(async (name) => Buffer.from(await (await get('/terrain/' + name)).arrayBuffer())),
  );
  assert.equal(height.length, 33 * 33 * 4);
  assert.equal(water.length, 33 * 33);
  for (let i = 0; i < height.length; i += 4) assert.ok(Number.isFinite(height.readFloatLE(i)));
  assert.ok(water.every((value) => value === 0 || value === 1));
  files.set(file, height);
  files.set(waterFile, water);
}

await mkdir(FARMLAND_TERRAIN_PACKAGE);
await Promise.all([...files].map(([name, contents]) => writeFile(join(FARMLAND_TERRAIN_PACKAGE, name), contents)));
console.log('Phase 2 API acceptance passed. The terrain package is ready for the Unity mesh check.');

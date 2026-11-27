import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { processTerrainJob, type TerrainJobConfig } from './terrain-job.js';

const { DATABASE_URL, TERRAIN_ROOT, TERRAIN_SOURCE, TERRAIN_SOURCE_ID, TERRAIN_PYTHON, TERRAIN_WATER_SOURCE, TERRAIN_WATER_SOURCE_ID } = process.env;
if (!DATABASE_URL || !TERRAIN_ROOT || !TERRAIN_SOURCE || !TERRAIN_SOURCE_ID) {
  throw new Error('Set DATABASE_URL, TERRAIN_ROOT, TERRAIN_SOURCE, and TERRAIN_SOURCE_ID.');
}

if (Boolean(TERRAIN_WATER_SOURCE) !== Boolean(TERRAIN_WATER_SOURCE_ID)) {
  throw new Error('Set TERRAIN_WATER_SOURCE and TERRAIN_WATER_SOURCE_ID together.');
}

const water = TERRAIN_WATER_SOURCE && TERRAIN_WATER_SOURCE_ID
  ? { source: resolve(TERRAIN_WATER_SOURCE), sourceId: TERRAIN_WATER_SOURCE_ID }
  : undefined;
if (water) await access(water.source);
const source = resolve(TERRAIN_SOURCE);
await access(source);
const config: TerrainJobConfig = {
  root: resolve(TERRAIN_ROOT),
  source,
  water,
  sourceId: TERRAIN_SOURCE_ID,
  python: TERRAIN_PYTHON ?? 'python3',
  exporter: fileURLToPath(new URL('../workers/terrain/export.py', import.meta.url)),
};

const watch = process.argv.includes('--watch');
const shutdown = new AbortController();
const stop = () => shutdown.abort();
if (watch) {
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });
try {
  do {
    const status = await processTerrainJob(pool, config);
    if (!watch) {
      console.log(status);
      if (status === 'failed' || status === 'lease_lost') process.exitCode = 1;
      break;
    }

    if (status !== 'idle') console.log(status);
    if (status === 'idle' && !shutdown.signal.aborted) {
      try {
        await delay(5000, undefined, { signal: shutdown.signal });
      } catch (error) {
        if (!shutdown.signal.aborted) throw error;
      }
    }
  } while (!shutdown.signal.aborted);
} finally {
  await pool.end();
  if (watch) {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

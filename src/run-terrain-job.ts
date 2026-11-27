import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { processTerrainJob } from './terrain-job.js';

const { DATABASE_URL, TERRAIN_ROOT, TERRAIN_SOURCE, TERRAIN_SOURCE_ID, TERRAIN_PYTHON } = process.env;
if (!DATABASE_URL || !TERRAIN_ROOT || !TERRAIN_SOURCE || !TERRAIN_SOURCE_ID) {
  throw new Error('Set DATABASE_URL, TERRAIN_ROOT, TERRAIN_SOURCE, and TERRAIN_SOURCE_ID.');
}

const source = resolve(TERRAIN_SOURCE);
await access(source);
const pool = new pg.Pool({ connectionString: DATABASE_URL });
try {
  const status = await processTerrainJob(pool, {
    root: resolve(TERRAIN_ROOT),
    source,
    sourceId: TERRAIN_SOURCE_ID,
    python: TERRAIN_PYTHON ?? 'python3',
    exporter: fileURLToPath(new URL('../workers/terrain/export.py', import.meta.url)),
  });
  console.log(status);
  if (status === 'failed' || status === 'lease_lost') process.exitCode = 1;
} finally {
  await pool.end();
}

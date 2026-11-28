import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Pool } from 'pg';

type TerrainLease = {
  worldId: string;
  leaseId: string;
  latitude: number;
  longitude: number;
  areaKm2: number;
};

export type TerrainJobConfig = {
  root: string;
  source: string;
  sourceId: string;
  python: string;
  exporter: string;
  water?: { source: string; sourceId: string };
};

const run = promisify(execFile);

async function claim(pool: Pool): Promise<TerrainLease | undefined> {
  const { rows: [job] } = await pool.query<TerrainLease>(
    `WITH candidate AS (
       SELECT world_id FROM world_requests
       WHERE status = 'queued' OR (status = 'generating' AND lease_expires_at <= statement_timestamp())
       ORDER BY created_at, world_id LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE world_requests AS world
     SET status = 'generating', lease_id = $1, lease_expires_at = statement_timestamp() + interval '5 minutes'
     FROM candidate WHERE world.world_id = candidate.world_id
     RETURNING world.world_id AS "worldId", world.lease_id AS "leaseId",
       latitude, longitude, area_km2 AS "areaKm2"`,
    [randomUUID()],
  );
  return job;
}

export async function processTerrainJob(pool: Pool, config: TerrainJobConfig) {
  await mkdir(config.root, { recursive: true });
  const job = await claim(pool);
  if (!job) return 'idle';

  const parent = join(config.root, job.worldId);
  const output = join(parent, job.leaseId);
  let failureCode: string | null = null;
  try {
    await mkdir(parent, { recursive: true });
    await run(config.python, [
      config.exporter, config.source, output, '--source-id', config.sourceId,
      '--latitude', String(job.latitude), '--longitude', String(job.longitude),
      '--area-km2', String(job.areaKm2),
      ...(config.water ? ['--water-source', config.water.source, '--water-source-id', config.water.sourceId] : []),
    ], { timeout: 120_000, killSignal: 'SIGKILL' });
  } catch (error) {
    const exitCode = (error as { code?: number | string }).code;
    failureCode = exitCode === 3 ? 'terrain_outside_coverage' : 'terrain_export_failed';
  }

  const status = failureCode ? 'failed' : 'ready';
  const result = await pool.query(
    `UPDATE world_requests
     SET status = $3, lease_id = NULL, lease_expires_at = NULL,
         artifact_id = CASE WHEN $3 = 'ready' THEN $2::uuid ELSE NULL END, failure_code = $4
     WHERE world_id = $1 AND lease_id = $2 AND status = 'generating'
       AND lease_expires_at > statement_timestamp()`,
    [job.worldId, job.leaseId, status, failureCode],
  );

  if (failureCode || result.rowCount === 0) await rm(output, { recursive: true, force: true });
  return result.rowCount === 0 ? 'lease_lost' : status;
}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

type WorldSelection = {
  requestId: string;
  latitude: number;
  longitude: number;
  areaKm2: 1 | 4 | 9;
};

type WorldSubmission = WorldSelection & { replaceFailedRequestId?: string };

type WorldRequest = WorldSelection & {
  worldId: string;
  status: 'queued' | 'generating' | 'ready' | 'failed';
  createdAt: Date;
  failureCode: string | null;
};

const selectionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['requestId', 'latitude', 'longitude', 'areaKm2'],
  properties: {
    requestId: { type: 'string', pattern: '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' },
    replaceFailedRequestId: { type: 'string', pattern: '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' },
    latitude: { type: 'number', minimum: -80, maximum: 80 },
    longitude: { type: 'number', minimum: -180, exclusiveMaximum: 180 },
    areaKm2: { type: 'integer', enum: [1, 4, 9] },
  },
} as const;

const worldColumns = `world_id AS "worldId", request_id AS "requestId",
  latitude, longitude, area_km2 AS "areaKm2", status, created_at AS "createdAt", failure_code AS "failureCode"`;

export class WorldStore {
  constructor(private readonly pool: Pool) {}

  async load(playerUid: string): Promise<WorldRequest | undefined> {
    const { rows } = await this.pool.query<WorldRequest>(
      `SELECT ${worldColumns} FROM world_requests WHERE player_uid = $1`,
      [playerUid],
    );
    return rows[0];
  }

  async loadArtifact(playerUid: string) {
    const { rows: [artifact] } = await this.pool.query<{
      worldId: string; artifactId: string; areaKm2: number;
    }>(
      `SELECT world_id AS "worldId", artifact_id AS "artifactId", area_km2 AS "areaKm2"
       FROM world_requests WHERE player_uid = $1 AND status = 'ready'`,
      [playerUid],
    );
    return artifact;
  }

  async replaceFailed(playerUid: string, selection: WorldSelection, failedRequestId: string) {
    const { rows: [world] } = await this.pool.query<WorldRequest>(
      `UPDATE world_requests
       SET request_id = $2, latitude = $3, longitude = $4, area_km2 = $5,
           status = 'queued', failure_code = NULL, created_at = statement_timestamp()
       WHERE player_uid = $1 AND request_id = $6 AND status = 'failed' AND request_id <> $2
       RETURNING ${worldColumns}`,
      [playerUid, selection.requestId, selection.latitude, selection.longitude, selection.areaKm2, failedRequestId],
    );
    if (world) return { created: true, world };
    return { created: false, world: await this.load(playerUid) };
  }

  async queue(playerUid: string, selection: WorldSelection) {
    const { rows: [created] } = await this.pool.query<WorldRequest>(
      `INSERT INTO world_requests (player_uid, request_id, latitude, longitude, area_km2)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (player_uid) DO NOTHING
       RETURNING ${worldColumns}`,
      [playerUid, selection.requestId, selection.latitude, selection.longitude, selection.areaKm2],
    );
    if (created) return { created: true, world: created };

    // Read in a separate statement so a concurrent insert that won the conflict is visible.
    return { created: false, world: await this.load(playerUid) };
  }
}

export function registerWorldRoutes(api: FastifyInstance, store: WorldStore, terrainRoot?: string) {
  api.get('/world', async (request, reply) => {
    const world = await store.load(request.playerUid);
    if (!world) return reply.code(404).send({ code: 'world_not_found' });
    return world;
  });

  if (terrainRoot) {
    api.get<{ Params: { filename: string } }>('/world/terrain/:filename', async (request, reply) => {
      const artifact = await store.loadArtifact(request.playerUid);
      const { filename } = request.params;
      const waterFile = filename.startsWith('water-');
      const chunk = (waterFile ? /^water-([0-2])-([0-2])\.u8$/ : /^height-([0-2])-([0-2])\.f32$/).exec(filename);
      const chunksPerAxis = artifact ? Math.sqrt(artifact.areaKm2) : 0;
      const validChunk = chunk && Number(chunk[1]) < chunksPerAxis && Number(chunk[2]) < chunksPerAxis;
      if (!artifact || (filename !== 'manifest.json' && !validChunk)) {
        return reply.code(404).send({ code: 'terrain_not_found' });
      }

      const path = join(terrainRoot, artifact.worldId, artifact.artifactId, filename);
      try {
        const contents = await readFile(path);
        const type = filename === 'manifest.json' ? 'application/json' : 'application/octet-stream';
        return reply.type(type).send(contents);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (waterFile) return reply.code(404).send({ code: 'terrain_not_found' });
        return reply.code(503).send({ code: 'terrain_unavailable' });
      }
    });
  }

  api.post<{ Body: WorldSubmission }>('/world', {
    schema: { body: selectionSchema },
  }, async (request, reply) => {
    const selection = request.body;
    const { created, world } = selection.replaceFailedRequestId
      ? await store.replaceFailed(request.playerUid, selection, selection.replaceFailedRequestId)
      : await store.queue(request.playerUid, selection);
    if (!world) return reply.code(409).send({ code: 'world_selection_changed' });
    if (created) return reply.code(201).send(world);

    if (world.requestId !== selection.requestId.toLowerCase()) {
      return reply.code(409).send({ code: 'world_already_exists', world });
    }
    if (world.latitude !== selection.latitude || world.longitude !== selection.longitude ||
        world.areaKm2 !== selection.areaKm2) {
      return reply.code(409).send({ code: 'request_id_reused', world });
    }
    return world;
  });
}

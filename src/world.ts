import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

type WorldSelection = {
  requestId: string;
  latitude: number;
  longitude: number;
  areaKm2: 1 | 4 | 9;
};

type WorldRequest = WorldSelection & {
  worldId: string;
  status: 'queued' | 'generating' | 'ready' | 'failed';
  createdAt: Date;
};

const selectionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['requestId', 'latitude', 'longitude', 'areaKm2'],
  properties: {
    requestId: { type: 'string', pattern: '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' },
    latitude: { type: 'number', minimum: -80, maximum: 80 },
    longitude: { type: 'number', minimum: -180, exclusiveMaximum: 180 },
    areaKm2: { type: 'integer', enum: [1, 4, 9] },
  },
} as const;

const worldColumns = `world_id AS "worldId", request_id AS "requestId",
  latitude, longitude, area_km2 AS "areaKm2", status, created_at AS "createdAt"`;

export class WorldStore {
  constructor(private readonly pool: Pool) {}

  async load(playerUid: string): Promise<WorldRequest | undefined> {
    const { rows } = await this.pool.query<WorldRequest>(
      `SELECT ${worldColumns} FROM world_requests WHERE player_uid = $1`,
      [playerUid],
    );
    return rows[0];
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

export function registerWorldRoutes(api: FastifyInstance, store: WorldStore) {
  api.get('/world', async (request, reply) => {
    const world = await store.load(request.playerUid);
    if (!world) return reply.code(404).send({ code: 'world_not_found' });
    return world;
  });

  api.post<{ Body: WorldSelection }>('/world', {
    schema: { body: selectionSchema },
  }, async (request, reply) => {
    const selection = request.body;
    const { created, world } = await store.queue(request.playerUid, selection);
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

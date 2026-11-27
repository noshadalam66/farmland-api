import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

type RankedFarm = { rank: number; name: string; harvests: number; isYou: boolean };
type Leaderboard = {
  category: 'harvests';
  enabled: boolean;
  entries: RankedFarm[];
  yourRank: RankedFarm | null;
};

export class LeaderboardStore {
  constructor(private readonly pool: Pool) {}

  async read(playerUid: string): Promise<Leaderboard> {
    const { rows: [board] } = await this.pool.query<{
      enabled: boolean;
      entries: RankedFarm[];
      your_rank: RankedFarm | null;
    }>(
      `WITH harvest_scores AS (
         SELECT preference.player_uid, preference.public_id,
           (SELECT count(*) FROM starter_farm_commands
             WHERE player_uid = preference.player_uid AND action = 'harvest') AS harvests
         FROM farm_leaderboard_preferences AS preference
         WHERE preference.enabled
       ), ranked AS (
         SELECT player_uid, public_id, harvests, rank() OVER (ORDER BY harvests DESC) AS rank
         FROM harvest_scores WHERE harvests > 0
       ), entries AS (
         SELECT player_uid, rank, public_id, jsonb_build_object(
           'rank', rank, 'name', 'Farm ' || left(replace(public_id::text, '-', ''), 12),
           'harvests', harvests, 'isYou', player_uid = $1
         ) AS entry FROM ranked
       )
       SELECT COALESCE((SELECT enabled FROM farm_leaderboard_preferences WHERE player_uid = $1), false) AS enabled,
         COALESCE((
           SELECT jsonb_agg(entry ORDER BY rank, public_id)
           FROM (SELECT entry, rank, public_id FROM entries ORDER BY rank, public_id LIMIT 20) AS leaders
         ), '[]'::jsonb) AS entries,
         (SELECT entry FROM entries WHERE player_uid = $1) AS your_rank`,
      [playerUid],
    );
    return { category: 'harvests', enabled: board.enabled, entries: board.entries, yourRank: board.your_rank };
  }

  async setEnabled(playerUid: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO farm_leaderboard_preferences (player_uid, enabled) VALUES ($1, $2)
       ON CONFLICT (player_uid) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [playerUid, enabled],
    );
  }
}

export function registerLeaderboardRoutes(api: FastifyInstance, store: LeaderboardStore) {
  api.get('/leaderboard/harvests', (request) => store.read(request.playerUid));
  api.put<{ Body: { enabled: boolean } }>('/leaderboard/preferences', {
    schema: { body: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled'],
      properties: { enabled: { type: 'boolean' } },
    } },
  }, async (request, reply) => {
    await store.setEnabled(request.playerUid, request.body.enabled);
    return reply.code(204).send();
  });
}

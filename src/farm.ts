import type { Pool, PoolClient } from 'pg';

export type FarmCommand = {
  commandId: string;
  expectedRevision: number;
  action: 'plant' | 'harvest';
};

type FarmRow = {
  revision: number;
  wheat: number;
  planted_at: Date | null;
  ready_at: Date | null;
};

export type FarmState = {
  revision: number;
  inventory: { wheat: number };
  plot: { plantedAt: string; readyAt: string } | null;
  serverTime: string;
};

type CommandResult =
  | { ok: true; state: FarmState }
  | { ok: false; code: 'command_id_reused' | 'stale_revision' | 'plot_occupied' | 'plot_empty' | 'crop_not_ready'; state: FarmState };

const growthMilliseconds = 60_000;

function snapshot(farm: FarmRow, now: Date): FarmState {
  return {
    revision: farm.revision,
    inventory: { wheat: farm.wheat },
    plot: farm.planted_at && farm.ready_at
      ? { plantedAt: farm.planted_at.toISOString(), readyAt: farm.ready_at.toISOString() }
      : null,
    serverTime: now.toISOString(),
  };
}

export class FarmStore {
  constructor(private readonly pool: Pool) {}

  async load(playerUid: string): Promise<FarmState> {
    const { rows: [farm] } = await this.pool.query<FarmRow & { server_time: Date }>(
      `SELECT COALESCE(farm.revision, 0) AS revision, COALESCE(farm.wheat, 0) AS wheat,
              farm.planted_at, farm.ready_at, statement_timestamp() AS server_time
       FROM (VALUES ($1::text)) AS player(uid)
       LEFT JOIN starter_farms AS farm ON farm.player_uid = player.uid`,
      [playerUid],
    );
    return snapshot(farm, farm.server_time);
  }

  async execute(playerUid: string, command: FarmCommand): Promise<CommandResult> {
    const client = await this.pool.connect();
    let discardConnection = false;
    try {
      await client.query('BEGIN');
      const result = await this.executeLocked(client, playerUid, command);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discardConnection = true;
      }
      throw error;
    } finally {
      client.release(discardConnection);
    }
  }

  private async executeLocked(client: PoolClient, playerUid: string, command: FarmCommand): Promise<CommandResult> {
    await client.query('INSERT INTO starter_farms (player_uid) VALUES ($1) ON CONFLICT DO NOTHING', [playerUid]);
    const { rows: [farm] } = await client.query<FarmRow>(
      'SELECT * FROM starter_farms WHERE player_uid = $1 FOR UPDATE',
      [playerUid],
    );
    const { rows: [{ server_time: now }] } = await client.query<{ server_time: Date }>(
      'SELECT clock_timestamp() AS server_time',
    );
    const state = snapshot(farm, now);
    const { rows: [previous] } = await client.query<{
      action: FarmCommand['action'];
      expected_revision: number;
      response: FarmState;
    }>(
      'SELECT action, expected_revision, response FROM starter_farm_commands WHERE player_uid = $1 AND command_id = $2',
      [playerUid, command.commandId],
    );

    if (previous) {
      if (previous.action !== command.action || previous.expected_revision !== command.expectedRevision) {
        return { ok: false, code: 'command_id_reused', state };
      }
      return { ok: true, state: previous.response };
    }
    if (farm.revision !== command.expectedRevision) return { ok: false, code: 'stale_revision', state };
    if (command.action === 'plant' && farm.ready_at) return { ok: false, code: 'plot_occupied', state };
    if (command.action === 'harvest') {
      if (!farm.ready_at) return { ok: false, code: 'plot_empty', state };
      if (now < farm.ready_at) return { ok: false, code: 'crop_not_ready', state };
    }

    const planting = command.action === 'plant';
    const { rows: [updated] } = await client.query<FarmRow>(
      `UPDATE starter_farms
       SET revision = revision + 1, wheat = wheat + $2, planted_at = $3, ready_at = $4
       WHERE player_uid = $1 RETURNING *`,
      [playerUid, planting ? 0 : 1, planting ? now : null, planting ? new Date(now.getTime() + growthMilliseconds) : null],
    );
    const response = snapshot(updated, now);
    await client.query(
      `INSERT INTO starter_farm_commands (player_uid, command_id, action, expected_revision, response)
       VALUES ($1, $2, $3, $4, $5)`,
      [playerUid, command.commandId, command.action, command.expectedRevision, response],
    );
    return { ok: true, state: response };
  }
}

import type { Pool, PoolClient } from 'pg';

export const crops = ['wheat', 'corn', 'rice'] as const;
type Crop = typeof crops[number];

export type FarmCommand = {
  commandId: string;
  expectedRevision: number;
  action: 'plant' | 'harvest';
  crop?: Crop;
};

type FarmRow = {
  revision: number;
  wheat: number;
  corn: number;
  rice: number;
  planted_crop: Crop | null;
  planted_at: Date | null;
  ready_at: Date | null;
};

export type FarmState = {
  revision: number;
  inventory: Record<Crop, number>;
  plot: { crop: Crop; plantedAt: string; readyAt: string } | null;
  serverTime: string;
};

type CommandResult =
  | { ok: true; state: FarmState }
  | { ok: false; code: 'command_id_reused' | 'stale_revision' | 'plot_occupied' | 'plot_empty' | 'crop_not_ready'; state: FarmState };

const growthMilliseconds: Record<Crop, number> = { wheat: 60_000, corn: 90_000, rice: 120_000 };

type SavedFarmState = Omit<FarmState, 'inventory' | 'plot'> & {
  inventory: { wheat: number; corn?: number; rice?: number };
  plot: { crop?: Crop; plantedAt: string; readyAt: string } | null;
};

function readSavedState(state: SavedFarmState): FarmState {
  return {
    ...state,
    inventory: { corn: 0, rice: 0, ...state.inventory },
    plot: state.plot ? { ...state.plot, crop: state.plot.crop ?? 'wheat' } : null,
  };
}

function snapshot(farm: FarmRow, now: Date): FarmState {
  return {
    revision: farm.revision,
    inventory: { wheat: farm.wheat, corn: farm.corn, rice: farm.rice },
    plot: farm.planted_at && farm.ready_at && farm.planted_crop
      ? { crop: farm.planted_crop, plantedAt: farm.planted_at.toISOString(), readyAt: farm.ready_at.toISOString() }
      : null,
    serverTime: now.toISOString(),
  };
}

export class FarmStore {
  constructor(private readonly pool: Pool) {}

  async load(playerUid: string): Promise<FarmState> {
    const { rows: [farm] } = await this.pool.query<FarmRow & { server_time: Date }>(
      `SELECT COALESCE(farm.revision, 0) AS revision, COALESCE(farm.wheat, 0) AS wheat,
              COALESCE(farm.corn, 0) AS corn, COALESCE(farm.rice, 0) AS rice,
              farm.planted_at, farm.ready_at, farm.planted_crop, statement_timestamp() AS server_time
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
      crop: Crop | null;
      response: SavedFarmState;
    }>(
      'SELECT action, expected_revision, crop, response FROM starter_farm_commands WHERE player_uid = $1 AND command_id = $2',
      [playerUid, command.commandId],
    );

    const plantCrop = command.action === 'plant' ? command.crop ?? 'wheat' : null;
    if (previous) {
      const previousCrop = previous.crop ?? (previous.action === 'plant' ? 'wheat' : null);
      if (previous.action !== command.action || previous.expected_revision !== command.expectedRevision ||
          previousCrop !== plantCrop) {
        return { ok: false, code: 'command_id_reused', state };
      }
      return { ok: true, state: readSavedState(previous.response) };
    }
    if (farm.revision !== command.expectedRevision) return { ok: false, code: 'stale_revision', state };
    if (command.action === 'plant' && farm.ready_at) return { ok: false, code: 'plot_occupied', state };
    if (command.action === 'harvest') {
      if (!farm.ready_at) return { ok: false, code: 'plot_empty', state };
      if (now < farm.ready_at) return { ok: false, code: 'crop_not_ready', state };
    }

    const harvestedCrop = plantCrop ? null : farm.planted_crop;
    const readyAt = plantCrop ? new Date(now.getTime() + growthMilliseconds[plantCrop]) : null;
    const { rows: [updated] } = await client.query<FarmRow>(
      `UPDATE starter_farms
       SET revision = revision + 1,
           wheat = wheat + CASE WHEN $2 = 'wheat' THEN 1 ELSE 0 END,
           corn = corn + CASE WHEN $2 = 'corn' THEN 1 ELSE 0 END,
           rice = rice + CASE WHEN $2 = 'rice' THEN 1 ELSE 0 END,
           planted_at = $3, ready_at = $4, planted_crop = $5
       WHERE player_uid = $1 RETURNING *`,
      [playerUid, harvestedCrop, plantCrop ? now : null, readyAt, plantCrop],
    );
    const response = snapshot(updated, now);
    await client.query(
      `INSERT INTO starter_farm_commands (player_uid, command_id, action, expected_revision, response, crop)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [playerUid, command.commandId, command.action, command.expectedRevision, response, plantCrop],
    );
    return { ok: true, state: response };
  }
}

import type { Pool, PoolClient } from 'pg';
import { animalCapacity, animalPrices, animalRosterExpression, purchaseAnimal, type Animal, type AnimalSpecies } from './livestock.js';

export const crops = ['wheat', 'corn', 'rice'] as const;
type Crop = typeof crops[number];
type PlotId = 'starter' | 'expansion';

export type FarmCommand = {
  commandId: string;
  expectedRevision: number;
} & (
  | { action: 'plant'; species?: never; crop?: Crop; plotId?: PlotId }
  | { action: 'harvest'; species?: never; crop?: never; plotId?: PlotId }
  | { action: 'sell'; species?: never; crop: Crop; plotId?: never }
  | { action: 'buy_parcel'; crop?: never; plotId?: never; species?: never }
  | { action: 'buy_animal'; crop?: never; plotId?: never; species: AnimalSpecies }
);

type FarmRow = PlotRow & {
  revision: number;
  wheat: number;
  corn: number;
  rice: number;
  coins: number;
};

type PlotRow = {
  planted_crop: Crop | null;
  planted_at: Date | null;
  ready_at: Date | null;
};

export type FarmState = {
  revision: number;
  inventory: Record<Crop, number>;
  wallet: { coins: number };
  market: { sellPrices: Record<Crop, number> };
  plot: PlotState;
  expansion: { owned: boolean; price: number; plot: PlotState };
  livestock: { animals: Animal[]; prices: Record<AnimalSpecies, number>; capacity: number };
  serverTime: string;
};

type PlotState = { crop: Crop; plantedAt: string; readyAt: string } | null;

type CommandResult =
  | { ok: true; state: FarmState }
  | { ok: false; code: 'command_id_reused' | 'stale_revision' | 'plot_occupied' | 'plot_empty' | 'crop_not_ready' | 'insufficient_crop' | 'insufficient_coins' | 'parcel_already_owned' | 'parcel_not_owned' | 'livestock_capacity'; state: FarmState };

const expansionPrice = 7;
const sellPrices: Record<Crop, number> = { wheat: 3, corn: 5, rice: 7 };
const growthMilliseconds: Record<Crop, number> = { wheat: 60_000, corn: 90_000, rice: 120_000 };

type SavedFarmState = Omit<FarmState, 'inventory' | 'plot' | 'wallet' | 'market' | 'expansion' | 'livestock'> & {
  inventory: { wheat: number; corn?: number; rice?: number };
  wallet?: FarmState['wallet'];
  market?: FarmState['market'];
  expansion?: FarmState['expansion'];
  livestock?: FarmState['livestock'];
  plot: { crop?: Crop; plantedAt: string; readyAt: string } | null;
};

function readSavedState(state: SavedFarmState): FarmState {
  return {
    ...state,
    inventory: { corn: 0, rice: 0, ...state.inventory },
    wallet: state.wallet ?? { coins: 0 },
    market: state.market ?? { sellPrices },
    expansion: state.expansion ?? { owned: false, price: expansionPrice, plot: null },
    livestock: state.livestock ?? { animals: [], prices: animalPrices, capacity: animalCapacity },
    plot: state.plot ? { ...state.plot, crop: state.plot.crop ?? 'wheat' } : null,
  };
}

function plotState(plot: PlotRow | undefined): PlotState {
  if (!plot?.planted_at || !plot.ready_at || !plot.planted_crop) return null;
  return { crop: plot.planted_crop, plantedAt: plot.planted_at.toISOString(), readyAt: plot.ready_at.toISOString() };
}

function snapshot(farm: FarmRow, now: Date, animals: Animal[], expansion?: PlotRow): FarmState {
  return {
    revision: farm.revision,
    inventory: { wheat: farm.wheat, corn: farm.corn, rice: farm.rice },
    wallet: { coins: farm.coins },
    market: { sellPrices },
    plot: plotState(farm),
    livestock: { animals, prices: animalPrices, capacity: animalCapacity },
    expansion: { owned: expansion !== undefined, price: expansionPrice, plot: plotState(expansion) },
    serverTime: now.toISOString(),
  };
}

export class FarmStore {
  constructor(private readonly pool: Pool) {}

  async load(playerUid: string): Promise<FarmState> {
    const { rows: [farm] } = await this.pool.query<FarmRow & { server_time: Date; expansion_owned: boolean; expansion_crop: Crop | null;
      expansion_planted_at: Date | null; expansion_ready_at: Date | null; animals: Animal[] }>(
      `SELECT COALESCE(farm.revision, 0) AS revision, COALESCE(farm.wheat, 0) AS wheat,
              COALESCE(farm.corn, 0) AS corn, COALESCE(farm.rice, 0) AS rice,
              COALESCE(farm.coins, 0) AS coins, farm.planted_at, farm.ready_at, farm.planted_crop, statement_timestamp() AS server_time,
              expansion.player_uid IS NOT NULL AS expansion_owned, expansion.planted_crop AS expansion_crop,
              expansion.planted_at AS expansion_planted_at, expansion.ready_at AS expansion_ready_at,
              ${animalRosterExpression} AS animals
       FROM (VALUES ($1::text)) AS player(uid)
       LEFT JOIN starter_farms AS farm ON farm.player_uid = player.uid
       LEFT JOIN farm_expansion_plots AS expansion ON expansion.player_uid = player.uid`,
      [playerUid],
    );
    const expansion = farm.expansion_owned ? {
      planted_crop: farm.expansion_crop, planted_at: farm.expansion_planted_at, ready_at: farm.expansion_ready_at,
    } : undefined;
    return snapshot(farm, farm.server_time, farm.animals, expansion);
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
    const { rows: [expansion] } = await client.query<PlotRow>(
      'SELECT planted_crop, planted_at, ready_at FROM farm_expansion_plots WHERE player_uid = $1',
      [playerUid],
    );
    const { rows: [{ animals }] } = await client.query<{ animals: Animal[] }>(
      `SELECT ${animalRosterExpression} AS animals FROM (VALUES ($1::text)) AS player(uid)`, [playerUid],
    );
    const state = snapshot(farm, now, animals, expansion);
    const { rows: [previous] } = await client.query<{
      action: FarmCommand['action'];
      expected_revision: number;
      crop: Crop | null;
      plot_id: PlotId | null;
      animal_species: AnimalSpecies | null;
      response: SavedFarmState;
    }>(
      'SELECT action, expected_revision, crop, plot_id, animal_species, response FROM starter_farm_commands WHERE player_uid = $1 AND command_id = $2',
      [playerUid, command.commandId],
    );

    const commandCrop = command.action === 'plant' ? command.crop ?? 'wheat' : command.crop ?? null;
    const isPlotCommand = command.action === 'plant' || command.action === 'harvest';
    const plotId = isPlotCommand ? command.plotId ?? 'starter' : null;
    if (previous) {
      const previousCrop = previous.crop ?? (previous.action === 'plant' ? 'wheat' : null);
      const previousPlot = previous.plot_id ?? (previous.action === 'plant' || previous.action === 'harvest' ? 'starter' : null);
      if (previous.action !== command.action || previous.expected_revision !== command.expectedRevision ||
          previousCrop !== commandCrop || previousPlot !== plotId || previous.animal_species !== (command.species ?? null)) {
        return { ok: false, code: 'command_id_reused', state };
      }
      return { ok: true, state: readSavedState(previous.response) };
    }
    if (farm.revision !== command.expectedRevision) return { ok: false, code: 'stale_revision', state };
    const plot = plotId === 'expansion' ? expansion : farm;
    if (isPlotCommand && !plot) return { ok: false, code: 'parcel_not_owned', state };
    if (command.action === 'plant' && plot?.ready_at) return { ok: false, code: 'plot_occupied', state };
    if (command.action === 'harvest') {
      if (!plot?.ready_at) return { ok: false, code: 'plot_empty', state };
      if (now < plot.ready_at) return { ok: false, code: 'crop_not_ready', state };
    }
    if (command.action === 'sell' && farm[command.crop] < 1) {
      return { ok: false, code: 'insufficient_crop', state };
    }
    if (command.action === 'buy_parcel') {
      if (expansion) return { ok: false, code: 'parcel_already_owned', state };
      if (farm.coins < expansionPrice) return { ok: false, code: 'insufficient_coins', state };
    }

    if (command.action === 'buy_animal') {
      if (animals.length >= animalCapacity) return { ok: false, code: 'livestock_capacity', state };
      if (farm.coins < animalPrices[command.species]) return { ok: false, code: 'insufficient_coins', state };
    }

    let coinDelta = 0;
    let reason: string | null = null;
    let updatedExpansion: PlotRow | undefined = expansion;
    let updated: FarmRow;
    let updatedAnimals = animals;
    switch (command.action) {
      case 'sell':
        coinDelta = sellPrices[command.crop];
        reason = 'crop_sale';
        updated = await this.sellCrop(client, playerUid, command.crop, coinDelta);
        break;
      case 'buy_parcel': {
        coinDelta = -expansionPrice;
        reason = 'parcel_purchase';
        const { rows: [bought] } = await client.query<PlotRow>(
          'INSERT INTO farm_expansion_plots (player_uid) VALUES ($1) RETURNING *', [playerUid],
        );
        updatedExpansion = bought;
        updated = await this.debitWallet(client, playerUid, coinDelta);
        break;
      }
      case 'buy_animal':
        coinDelta = -animalPrices[command.species];
        reason = 'animal_purchase';
        updatedAnimals = [...animals, await purchaseAnimal(client, playerUid, command.species)];
        updated = await this.debitWallet(client, playerUid, coinDelta);
        break;
      default: {
        const plantCrop = command.action === 'plant' ? commandCrop : null;
        const harvestedCrop = command.action === 'harvest' ? plot?.planted_crop ?? null : null;
        const times = {
          planted_at: plantCrop ? now : null,
          ready_at: plantCrop ? new Date(now.getTime() + growthMilliseconds[plantCrop]) : null,
          planted_crop: plantCrop,
        };
        if (plotId === 'expansion') {
          await client.query(
            `UPDATE farm_expansion_plots SET planted_at = $2, ready_at = $3, planted_crop = $4
             WHERE player_uid = $1`,
            [playerUid, times.planted_at, times.ready_at, times.planted_crop],
          );
          updatedExpansion = times;
        }
        updated = await this.updatePlot(client, playerUid, harvestedCrop, plotId === 'starter', times);
      }
    }
    const response = snapshot(updated, now, updatedAnimals, updatedExpansion);
    await client.query(
      `INSERT INTO starter_farm_commands (player_uid, command_id, action, expected_revision, response, crop, plot_id, animal_species)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [playerUid, command.commandId, command.action, command.expectedRevision, response, commandCrop, plotId, command.species ?? null],
    );
    if (reason) {
      await client.query(
        `INSERT INTO farm_wallet_entries (player_uid, command_id, reason, coin_delta, balance_after)
         VALUES ($1, $2, $3, $4, $5)`,
        [playerUid, command.commandId, reason, coinDelta, updated.coins],
      );
    }
    return { ok: true, state: response };
  }

  private async debitWallet(client: PoolClient, playerUid: string, coinDelta: number) {
    const { rows: [updated] } = await client.query<FarmRow>(
      'UPDATE starter_farms SET coins = coins + $2, revision = revision + 1 WHERE player_uid = $1 RETURNING *',
      [playerUid, coinDelta],
    );
    return updated;
  }

  private async sellCrop(client: PoolClient, playerUid: string, crop: Crop, price: number) {
    const { rows: [updated] } = await client.query<FarmRow>(
      `UPDATE starter_farms
       SET revision = revision + 1, coins = coins + $3,
           wheat = wheat - CASE WHEN $2 = 'wheat' THEN 1 ELSE 0 END,
           corn = corn - CASE WHEN $2 = 'corn' THEN 1 ELSE 0 END,
           rice = rice - CASE WHEN $2 = 'rice' THEN 1 ELSE 0 END
       WHERE player_uid = $1 RETURNING *`,
      [playerUid, crop, price],
    );
    return updated;
  }

  private async updatePlot(client: PoolClient, playerUid: string, harvestedCrop: Crop | null,
    isStarter: boolean, plot: PlotRow) {
    const { rows: [updated] } = await client.query<FarmRow>(
      `UPDATE starter_farms
       SET revision = revision + 1,
           wheat = wheat + CASE WHEN $2 = 'wheat' THEN 1 ELSE 0 END,
           corn = corn + CASE WHEN $2 = 'corn' THEN 1 ELSE 0 END,
           rice = rice + CASE WHEN $2 = 'rice' THEN 1 ELSE 0 END,
           planted_at = CASE WHEN $3 THEN $4 ELSE planted_at END,
           ready_at = CASE WHEN $3 THEN $5 ELSE ready_at END,
           planted_crop = CASE WHEN $3 THEN $6 ELSE planted_crop END
       WHERE player_uid = $1 RETURNING *`,
      [playerUid, harvestedCrop, isStarter, plot.planted_at, plot.ready_at, plot.planted_crop],
    );
    return updated;
  }
}

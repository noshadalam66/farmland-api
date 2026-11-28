import type { Pool, PoolClient } from 'pg';
import { animalCapacity, animalProductPrices, animalPrices, animalProduction, animalRosterExpression, breedingExpression, createAnimal, eligiblePair, setProductionTimer,
  type Animal, type AnimalSaleAction, type AnimalSpecies, type Breeding } from './livestock.js';

import { bakeryExpression, bakeryState, planBakeryAction, type Bakery, type BakeryAction, type BakeryError } from './bakery.js';
import { millExpression, millState, planMillAction, type Mill, type MillAction, type MillError } from './mill.js';

import { constructBuilding, constructionPrice, townBuildingsExpression, townState,
  type BuildingKind, type TownBuilding, type TownError } from './town.js';

import { fulfilledOrdersExpression, orderState, planTownOrder, utcOrderDate,
  type TownOrderError, type TownOrderKey } from './town-orders.js';

export const crops = ['wheat', 'corn', 'rice'] as const;
type Crop = typeof crops[number];
type Product = 'milk' | 'eggs' | 'flour' | 'bread';
type PlotId = 'starter' | 'expansion';

export type FarmCommand = {
  commandId: string;
  expectedRevision: number;
  partnerId?: string;
  building?: BuildingKind;
  orderKey?: TownOrderKey;
  orderDate?: string;
} & (
  | { action: 'plant'; species?: never; animalId?: never; crop?: Crop; plotId?: PlotId }
  | { action: 'harvest'; species?: never; animalId?: never; crop?: never; plotId?: PlotId }
  | { action: 'sell'; species?: never; animalId?: never; crop: Crop; plotId?: never }
  | { action: 'buy_parcel'; crop?: never; plotId?: never; species?: never; animalId?: never }
  | { action: 'buy_animal'; crop?: never; plotId?: never; species: AnimalSpecies; animalId?: never }
  | { action: 'feed_animal' | 'collect_animal'; crop?: never; plotId?: never; species?: never; animalId: string }
  | { action: 'start_breeding'; crop?: never; plotId?: never; species?: never; animalId: string; partnerId: string }
  | { action: 'collect_offspring' | MillAction | AnimalSaleAction | BakeryAction; crop?: never; plotId?: never; species?: never; animalId?: never }
  | { action: 'build_town'; crop?: never; plotId?: never; species?: never; animalId?: never; building: BuildingKind }
  | { action: 'fulfil_town_order'; crop?: never; plotId?: never; species?: never; animalId?: never; orderKey: TownOrderKey; orderDate: string }
);

type FarmRow = PlotRow & {
  revision: number;
  wheat: number;
  corn: number;
  rice: number;
  coins: number;
  milk: number;
  eggs: number;
  flour: number;
  bread: number;
  bakery_storage_upgraded: boolean;
};

type PlotRow = {
  planted_crop: Crop | null;
  planted_at: Date | null;
  ready_at: Date | null;
};

export type FarmState = {
  revision: number;
  inventory: Record<Crop | Product, number>;
  wallet: { coins: number };
  market: { sellPrices: Record<Crop, number> };
  cropGrowthMilliseconds: Record<Crop, number>;
  plot: PlotState;
  expansion: { owned: boolean; price: number; plot: PlotState };
  livestock: { animals: Animal[]; prices: Record<AnimalSpecies, number>; capacity: number; breeding: Breeding | null; productPrices: typeof animalProductPrices };
  mill: ReturnType<typeof millState>;
  bakery: ReturnType<typeof bakeryState>;
  town: ReturnType<typeof townState>;
  townOrders: ReturnType<typeof orderState>;
  serverTime: string;
};

type PlotState = { crop: Crop; plantedAt: string; readyAt: string } | null;

type CommandResult =
  | { ok: true; state: FarmState }
  | { ok: false; code: 'command_id_reused' | 'stale_revision' | 'plot_occupied' | 'plot_empty' | 'crop_not_ready' | 'insufficient_crop' | 'insufficient_coins' | 'parcel_already_owned' | 'parcel_not_owned' | 'livestock_capacity' | 'animal_not_owned' | 'animal_not_mature' | 'insufficient_animal_product' | 'animal_already_fed' | 'animal_not_fed' | 'product_not_ready' | 'breeding_in_progress' | 'breeding_not_started' | 'offspring_not_ready' | 'invalid_breeding_pair' | BakeryError | MillError | TownError | TownOrderError; state: FarmState };

const expansionPrice = 7;
const sellPrices: Record<Crop, number> = { wheat: 3, corn: 5, rice: 7 };
const growthMilliseconds: Record<Crop, number> = { wheat: 60_000, corn: 90_000, rice: 120_000 };

type SavedFarmState = Omit<FarmState, 'cropGrowthMilliseconds' | 'inventory' | 'plot' | 'wallet' | 'market' | 'expansion' | 'livestock' | 'mill' | 'bakery' | 'town' | 'townOrders'> & {
  inventory: { wheat: number; corn?: number; rice?: number; milk?: number; eggs?: number; flour?: number; bread?: number };
  cropGrowthMilliseconds?: FarmState['cropGrowthMilliseconds'];
  wallet?: FarmState['wallet'];
  market?: FarmState['market'];
  expansion?: FarmState['expansion'];
  livestock?: Omit<FarmState['livestock'], 'productPrices'> & Pick<Partial<FarmState['livestock']>, 'productPrices'>;
  mill?: FarmState['mill'];
  bakery?: FarmState['bakery'];
  town?: FarmState['town'];
  townOrders?: FarmState['townOrders'];
  plot: { crop?: Crop; plantedAt: string; readyAt: string } | null;
};

function readSavedState(state: SavedFarmState): FarmState {
  return {
    ...state,
    inventory: { corn: 0, rice: 0, milk: 0, eggs: 0, flour: 0, bread: 0, ...state.inventory },
    mill: state.mill ?? millState(null),
    bakery: state.bakery ?? bakeryState(null, state.mill?.owned === true),
    town: townState(state.town?.buildings ?? [], new Date(state.serverTime)),
    townOrders: state.townOrders ?? orderState(new Date(state.serverTime), state.town?.residents ?? 0, []),
    wallet: state.wallet ?? { coins: 0 },
    market: state.market ?? { sellPrices },
    cropGrowthMilliseconds: state.cropGrowthMilliseconds ?? growthMilliseconds,
    expansion: state.expansion ?? { owned: false, price: expansionPrice, plot: null },
    livestock: state.livestock ? {
      ...state.livestock,
      productPrices: state.livestock.productPrices ?? animalProductPrices,
      breeding: state.livestock.breeding ?? null,
      animals: state.livestock.animals.map((animal) => ({ ...animal, productReadyAt: animal.productReadyAt ?? null })),
    } : { animals: [], prices: animalPrices, capacity: animalCapacity, breeding: null, productPrices: animalProductPrices },
    plot: state.plot ? { ...state.plot, crop: state.plot.crop ?? 'wheat' } : null,
  };
}

function plotState(plot: PlotRow | undefined): PlotState {
  if (!plot?.planted_at || !plot.ready_at || !plot.planted_crop) return null;
  return { crop: plot.planted_crop, plantedAt: plot.planted_at.toISOString(), readyAt: plot.ready_at.toISOString() };
}

function snapshot(farm: FarmRow, now: Date, animals: Animal[], breeding: Breeding | null, mill: Mill | null, bakery: Bakery | null, buildings: TownBuilding[], fulfilled: TownOrderKey[], expansion?: PlotRow): FarmState {
  const town = townState(buildings, now);
  return {
    revision: farm.revision,
    inventory: { wheat: farm.wheat, corn: farm.corn, rice: farm.rice, milk: farm.milk, eggs: farm.eggs, flour: farm.flour, bread: farm.bread },
    wallet: { coins: farm.coins },
    market: { sellPrices },
    cropGrowthMilliseconds: growthMilliseconds,
    plot: plotState(farm),
    livestock: { animals, prices: animalPrices, capacity: animalCapacity, breeding, productPrices: animalProductPrices },
    expansion: { owned: expansion !== undefined, price: expansionPrice, plot: plotState(expansion) },
    mill: millState(mill),
    bakery: bakeryState(bakery, mill !== null, farm.bakery_storage_upgraded),
    town,
    townOrders: orderState(now, town.residents, fulfilled),
    serverTime: now.toISOString(),
  };
}

export class FarmStore {
  constructor(private readonly pool: Pool) {}

  async load(playerUid: string): Promise<FarmState> {
    const { rows: [farm] } = await this.pool.query<FarmRow & { server_time: Date; expansion_owned: boolean; expansion_crop: Crop | null;
      expansion_planted_at: Date | null; expansion_ready_at: Date | null; animals: Animal[]; breeding: Breeding | null; mill: Mill | null; bakery: Bakery | null; buildings: TownBuilding[]; fulfilled: TownOrderKey[] }>(
      `SELECT COALESCE(farm.revision, 0) AS revision, COALESCE(farm.wheat, 0) AS wheat,
              COALESCE(farm.corn, 0) AS corn, COALESCE(farm.rice, 0) AS rice,
              COALESCE(farm.milk, 0) AS milk, COALESCE(farm.eggs, 0) AS eggs,
              COALESCE(farm.flour, 0) AS flour, COALESCE(farm.bread, 0) AS bread,
              COALESCE(farm.bakery_storage_upgraded, false) AS bakery_storage_upgraded, COALESCE(farm.coins, 0) AS coins, farm.planted_at, farm.ready_at, farm.planted_crop, statement_timestamp() AS server_time,
              expansion.player_uid IS NOT NULL AS expansion_owned, expansion.planted_crop AS expansion_crop,
              expansion.planted_at AS expansion_planted_at, expansion.ready_at AS expansion_ready_at,
              ${animalRosterExpression} AS animals, ${breedingExpression} AS breeding, ${millExpression} AS mill, ${bakeryExpression} AS bakery, ${townBuildingsExpression} AS buildings, ${fulfilledOrdersExpression('statement_timestamp')} AS fulfilled
       FROM (VALUES ($1::text)) AS player(uid)
       LEFT JOIN starter_farms AS farm ON farm.player_uid = player.uid
       LEFT JOIN farm_expansion_plots AS expansion ON expansion.player_uid = player.uid`,
      [playerUid],
    );
    const expansion = farm.expansion_owned ? {
      planted_crop: farm.expansion_crop, planted_at: farm.expansion_planted_at, ready_at: farm.expansion_ready_at,
    } : undefined;
    return snapshot(farm, farm.server_time, farm.animals, farm.breeding, farm.mill, farm.bakery, farm.buildings, farm.fulfilled, expansion);
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
    const { rows: [{ animals, breeding, mill, bakery, buildings, fulfilled }] } = await client.query<{ animals: Animal[]; breeding: Breeding | null; mill: Mill | null; bakery: Bakery | null; buildings: TownBuilding[]; fulfilled: TownOrderKey[] }>(
      `SELECT ${animalRosterExpression} AS animals, ${breedingExpression} AS breeding, ${millExpression} AS mill, ${bakeryExpression} AS bakery, ${townBuildingsExpression} AS buildings, ${fulfilledOrdersExpression('parameter')} AS fulfilled FROM (VALUES ($1::text)) AS player(uid)`, [playerUid, utcOrderDate(now)],
    );
    const state = snapshot(farm, now, animals, breeding, mill, bakery, buildings, fulfilled, expansion);
    const { rows: [previous] } = await client.query<{
      action: FarmCommand['action'];
      expected_revision: number;
      crop: Crop | null;
      plot_id: PlotId | null;
      animal_species: AnimalSpecies | null;
      animal_id: string | null;
      partner_id: string | null;
      building_kind: BuildingKind | null;
      town_order_key: TownOrderKey | null;
      town_order_date: string | null;
      response: SavedFarmState;
    }>(
      `SELECT action, expected_revision, crop, plot_id, animal_species, animal_id, partner_id, building_kind,
         town_order_key, to_char(town_order_date, 'YYYY-MM-DD') AS town_order_date, response
       FROM starter_farm_commands WHERE player_uid = $1 AND command_id = $2`,
      [playerUid, command.commandId],
    );

    const commandCrop = command.action === 'plant' ? command.crop ?? 'wheat' : command.crop ?? null;
    const isPlotCommand = command.action === 'plant' || command.action === 'harvest';
    const plotId = isPlotCommand ? command.plotId ?? 'starter' : null;
    const animalId = command.animalId?.toLowerCase() ?? null;
    const partnerId = command.partnerId?.toLowerCase() ?? null;
    if (previous) {
      const previousCrop = previous.crop ?? (previous.action === 'plant' ? 'wheat' : null);
      const previousPlot = previous.plot_id ?? (previous.action === 'plant' || previous.action === 'harvest' ? 'starter' : null);
      if (previous.action !== command.action || previous.expected_revision !== command.expectedRevision ||
          previousCrop !== commandCrop || previousPlot !== plotId || previous.animal_species !== (command.species ?? null) ||
          previous.animal_id !== animalId || previous.partner_id !== partnerId ||
          previous.building_kind !== (command.building ?? null) || previous.town_order_key !== (command.orderKey ?? null) ||
          previous.town_order_date !== (command.orderDate ?? null)) {
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
      if (animals.length + (breeding ? 1 : 0) >= animalCapacity) return { ok: false, code: 'livestock_capacity', state };
      if (farm.coins < animalPrices[command.species]) return { ok: false, code: 'insufficient_coins', state };
    }

    const animal = animals.find((entry) => entry.animalId === animalId);
    if (command.action === 'feed_animal') {
      if (!animal) return { ok: false, code: 'animal_not_owned', state };
      if (animal.productReadyAt) return { ok: false, code: 'animal_already_fed', state };
      if (animal.matureAt && now.getTime() < Date.parse(animal.matureAt)) {
        return { ok: false, code: 'animal_not_mature', state };
      }
      if (farm.wheat < 1) return { ok: false, code: 'insufficient_crop', state };
    }
    if (command.action === 'collect_animal') {
      if (!animal) return { ok: false, code: 'animal_not_owned', state };
      if (!animal.productReadyAt) return { ok: false, code: 'animal_not_fed', state };
      if (now.getTime() < Date.parse(animal.productReadyAt)) {
        return { ok: false, code: 'product_not_ready', state };
      }
    }

    const partner = animals.find((entry) => entry.animalId === partnerId);
    if (command.action === 'start_breeding') {
      if (breeding) return { ok: false, code: 'breeding_in_progress', state };
      if (animals.length >= animalCapacity) return { ok: false, code: 'livestock_capacity', state };
      if (!animal || !partner) return { ok: false, code: 'animal_not_owned', state };
      if (!eligiblePair(animals, animal, partner, now)) return { ok: false, code: 'invalid_breeding_pair', state };
    }
    if (command.action === 'collect_offspring') {
      if (!breeding) return { ok: false, code: 'breeding_not_started', state };
      if (now.getTime() < Date.parse(breeding.readyAt)) return { ok: false, code: 'offspring_not_ready', state };
    }

    let coinDelta = 0;
    let reason: string | null = null;
    let updatedExpansion: PlotRow | undefined = expansion;
    let updated: FarmRow;
    let updatedAnimals = animals;
    let updatedBreeding = breeding;
    let updatedMill = mill;
    let updatedBakery = bakery;
    let updatedBuildings = buildings;
    let updatedFulfilled = fulfilled;
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
        updated = await this.adjustWallet(client, playerUid, coinDelta);
        break;
      }
      case 'buy_animal':
        coinDelta = -animalPrices[command.species];
        reason = 'animal_purchase';
        updatedAnimals = [...animals, await createAnimal(client, playerUid, command.species, animals)];
        updated = await this.adjustWallet(client, playerUid, coinDelta);
        break;
      case 'start_breeding': {
        if (!animal || !partner) throw new Error('Breeding pair was not validated.');
        const [mother, father] = animal.sex === 'female' ? [animal, partner] : [partner, animal];
        const readyAt = new Date(now.getTime() + 180_000).toISOString();
        updatedBreeding = { motherId: mother.animalId, fatherId: father.animalId, readyAt };
        await client.query(
          'INSERT INTO farm_breeding (player_uid, mother_id, father_id, ready_at) VALUES ($1, $2, $3, $4)',
          [playerUid, mother.animalId, father.animalId, readyAt],
        );
        updated = await this.adjustWallet(client, playerUid, 0);
        break;
      }
      case 'collect_offspring': {
        const mother = animals.find((entry) => entry.animalId === breeding?.motherId);
        if (!breeding || !mother) throw new Error('Breeding state has no mother.');
        updatedAnimals = [...animals, await createAnimal(client, playerUid, mother.species, animals, breeding, now)];
        await client.query('DELETE FROM farm_breeding WHERE player_uid = $1', [playerUid]);
        updatedBreeding = null;
        updated = await this.adjustWallet(client, playerUid, 0);
        break;
      }
      case 'feed_animal':
      case 'collect_animal': {
        if (!animal) throw new Error('Animal ownership must be validated before production.');
        const feeding = command.action === 'feed_animal';
        const production = animalProduction[animal.species];
        const readyAt = feeding ? new Date(now.getTime() + production.milliseconds) : null;
        await setProductionTimer(client, playerUid, animal.animalId, readyAt);
        updatedAnimals = animals.map((entry) => entry.animalId === animal.animalId
          ? { ...entry, productReadyAt: readyAt?.toISOString() ?? null }
          : entry);
        const { rows: [inventoryUpdated] } = await client.query<FarmRow>(
          `UPDATE starter_farms SET revision = revision + 1, wheat = wheat - $2,
             milk = milk + $3, eggs = eggs + $4 WHERE player_uid = $1 RETURNING *`,
          [playerUid, feeding ? 1 : 0, !feeding && production.product === 'milk' ? 1 : 0,
            !feeding && production.product === 'eggs' ? 1 : 0],
        );
        updated = inventoryUpdated;
        break;
      }
      case 'sell_milk':
      case 'sell_eggs': {
        const product = command.action === 'sell_milk' ? 'milk' : 'eggs';
        if (farm[product] < 1) return { ok: false, code: 'insufficient_animal_product', state };
        coinDelta = animalProductPrices[product];
        reason = 'livestock_sale';
        const { rows: [sold] } = await client.query<FarmRow>(
          `UPDATE starter_farms SET revision = revision + 1, coins = coins + $2,
             milk = milk - $3, eggs = eggs - $4 WHERE player_uid = $1 RETURNING *`,
          [playerUid, coinDelta, product === 'milk' ? 1 : 0, product === 'eggs' ? 1 : 0],
        );
        updated = sold;
        break;
      }
      case 'fulfil_town_order': {
        const offer = planTownOrder(command.orderKey, command.orderDate, now, state.town.residents, fulfilled, farm);
        if (typeof offer === 'string') return { ok: false, code: offer, state };
        coinDelta = offer.reward;
        reason = 'town_order';
        const { rows: [fulfilledFarm] } = await client.query<FarmRow>(
          `UPDATE starter_farms SET revision = revision + 1, coins = coins + $2,
             wheat = wheat - $3, flour = flour - $4, milk = milk - $5, bread = bread - $6
             WHERE player_uid = $1 RETURNING *`,
          [playerUid, offer.reward, offer.item === 'wheat' ? offer.quantity : 0,
            offer.item === 'flour' ? offer.quantity : 0, offer.item === 'milk' ? offer.quantity : 0, offer.item === 'bread' ? offer.quantity : 0],
        );
        updated = fulfilledFarm;
        updatedFulfilled = [...fulfilled, command.orderKey];
        break;
      }
      case 'build_town': {
        const price = constructionPrice(command.building, state.town, expansion !== undefined);
        if (typeof price === 'string') return { ok: false, code: price, state };
        if (farm.coins < price) return { ok: false, code: 'insufficient_coins', state };
        const building = await constructBuilding(client, playerUid, command.building, now);
        updatedBuildings = [...buildings, building];
        coinDelta = -price;
        reason = 'town_construction';
        updated = await this.adjustWallet(client, playerUid, coinDelta);
        break;
      }
      case 'buy_bakery':
      case 'start_baking':
      case 'collect_bread':
      case 'sell_bread':
      case 'upgrade_bakery_storage': {
        const plan = planBakeryAction(command.action, bakery, mill !== null, farm, now);
        if (typeof plan === 'string') return { ok: false, code: plan, state };
        if (command.action === 'buy_bakery') {
          await client.query('INSERT INTO farm_bakeries (player_uid) VALUES ($1)', [playerUid]);
        } else if (command.action === 'start_baking' || command.action === 'collect_bread') {
          await client.query('UPDATE farm_bakeries SET ready_at = $2 WHERE player_uid = $1',
            [playerUid, plan.bakery?.readyAt ?? null]);
        }
        const { rows: [baked] } = await client.query<FarmRow>(
          `UPDATE starter_farms SET revision = revision + 1, coins = coins + $2,
             flour = flour + $3, milk = milk + $4, eggs = eggs + $5, bread = bread + $6,
             bakery_storage_upgraded = bakery_storage_upgraded OR $7
             WHERE player_uid = $1 RETURNING *`,
          [playerUid, plan.coins, plan.flour, plan.milk, plan.eggs, plan.bread, plan.upgradeStorage],
        );
        updatedBakery = plan.bakery;
        coinDelta = plan.coins;
        reason = plan.reason;
        updated = baked;
        break;
      }
      case 'buy_mill':
      case 'start_milling':
      case 'collect_flour':
      case 'sell_flour': {
        const plan = planMillAction(command.action, mill, farm, now);
        if (typeof plan === 'string') return { ok: false, code: plan, state };
        if (command.action === 'buy_mill') {
          await client.query('INSERT INTO farm_grain_mills (player_uid) VALUES ($1)', [playerUid]);
        } else if (command.action !== 'sell_flour') {
          await client.query(
            'UPDATE farm_grain_mills SET ready_at = $2 WHERE player_uid = $1',
            [playerUid, plan.mill?.readyAt ?? null],
          );
        }
        const { rows: [milled] } = await client.query<FarmRow>(
          `UPDATE starter_farms SET revision = revision + 1,
             coins = coins + $2, wheat = wheat + $3, flour = flour + $4 WHERE player_uid = $1 RETURNING *`,
          [playerUid, plan.coins, plan.wheat, plan.flour],
        );
        updatedMill = plan.mill;
        coinDelta = plan.coins;
        reason = plan.reason;
        updated = milled;
        break;
      }
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
    const response = snapshot(updated, now, updatedAnimals, updatedBreeding, updatedMill, updatedBakery, updatedBuildings, updatedFulfilled, updatedExpansion);
    await client.query(
      `INSERT INTO starter_farm_commands (player_uid, command_id, action, expected_revision, response, crop, plot_id, animal_species, animal_id, partner_id, building_kind, town_order_key, town_order_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [playerUid, command.commandId, command.action, command.expectedRevision, response, commandCrop, plotId, command.species ?? null, animalId, partnerId, command.building ?? null, command.orderKey ?? null, command.orderDate ?? null],
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

  private async adjustWallet(client: PoolClient, playerUid: string, coinDelta: number) {
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

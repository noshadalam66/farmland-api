import type { PoolClient } from 'pg';

export const buildingKinds = ['road', 'cottage'] as const;
export type BuildingKind = typeof buildingKinds[number];

const catalog = {
  road: { price: 6, limit: 1, housing: 0 },
  cottage: { price: 12, limit: 4, housing: 3 },
} as const;
const residentIntervalSeconds = 60;

export type TownBuilding = { buildingId: string; kind: BuildingKind; builtAt: string };
export type TownError = 'town_requires_expansion' | 'town_requires_road' | 'town_building_limit';

const buildingJson = `jsonb_build_object('buildingId', building_id, 'kind', kind,
  'builtAt', to_char(built_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;

export const townBuildingsExpression = `COALESCE((
  SELECT jsonb_agg(${buildingJson} ORDER BY built_at, building_id)
  FROM farm_town_buildings WHERE player_uid = player.uid
), '[]'::jsonb)`;

export function townState(buildings: TownBuilding[], now: Date) {
  let residents = 0;
  let housingCapacity = 0;
  for (const building of buildings) {
    const housing = catalog[building.kind].housing;
    housingCapacity += housing;
    if (housing > 0) {
      const elapsedSeconds = (now.getTime() - Date.parse(building.builtAt)) / 1000;
      residents += Math.min(housing, Math.max(0, Math.floor(elapsedSeconds / residentIntervalSeconds)));
    }
  }
  return { buildings, housingCapacity, residents, residentIntervalSeconds, catalog };
}

export function constructionPrice(kind: BuildingKind, buildings: TownBuilding[], expansionOwned: boolean): number | TownError {
  if (!expansionOwned) return 'town_requires_expansion';
  if (kind === 'cottage' && !buildings.some((building) => building.kind === 'road')) return 'town_requires_road';
  if (buildings.filter((building) => building.kind === kind).length >= catalog[kind].limit) return 'town_building_limit';
  return catalog[kind].price;
}

export async function constructBuilding(client: PoolClient, playerUid: string, kind: BuildingKind, now: Date) {
  const { rows: [{ building }] } = await client.query<{ building: TownBuilding }>(
    `INSERT INTO farm_town_buildings (player_uid, kind, built_at)
     VALUES ($1, $2, $3) RETURNING ${buildingJson} AS building`,
    [playerUid, kind, now],
  );
  return building;
}

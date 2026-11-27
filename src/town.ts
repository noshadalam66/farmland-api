import type { PoolClient } from 'pg';

export const buildingKinds = ['road', 'cottage', 'water_tower', 'workshop', 'school', 'clinic'] as const;
export type BuildingKind = typeof buildingKinds[number];

type Service = 'water' | 'jobs' | 'education' | 'health';
type BuildingOption = {
  price: number;
  limit: number;
  housing: number;
  requires: BuildingKind | null;
  service?: Service;
  capacity?: number;
};

const catalog: Record<BuildingKind, BuildingOption> = {
  road: { price: 6, limit: 1, housing: 0, requires: null },
  cottage: { price: 12, limit: 4, housing: 3, requires: 'road' },
  water_tower: { price: 10, limit: 1, housing: 0, requires: 'road', service: 'water', capacity: 12 },
  workshop: { price: 14, limit: 2, housing: 0, requires: 'cottage', service: 'jobs', capacity: 4 },
  school: { price: 18, limit: 2, housing: 0, requires: 'cottage', service: 'education', capacity: 6 },
  clinic: { price: 20, limit: 2, housing: 0, requires: 'cottage', service: 'health', capacity: 8 },
};
const residentIntervalSeconds = 60;

export type TownBuilding = { buildingId: string; kind: BuildingKind; builtAt: string };
export type TownError = 'town_requires_expansion' | 'town_requires_road' | 'town_requires_cottage' | 'town_building_limit';

const buildingJson = `jsonb_build_object('buildingId', building_id, 'kind', kind,
  'builtAt', to_char(built_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;

export const townBuildingsExpression = `COALESCE((
  SELECT jsonb_agg(${buildingJson} ORDER BY built_at, building_id)
  FROM farm_town_buildings WHERE player_uid = player.uid
), '[]'::jsonb)`;

export function townState(buildings: TownBuilding[], now: Date) {
  let residents = 0;
  let housingCapacity = 0;
  const capacities: Record<Service, number> = { water: 0, jobs: 0, education: 0, health: 0 };
  for (const building of buildings) {
    const { housing, service, capacity } = catalog[building.kind];
    if (service && capacity) capacities[service] += capacity;
    housingCapacity += housing;
    if (housing > 0) {
      const elapsedSeconds = (now.getTime() - Date.parse(building.builtAt)) / 1000;
      residents += Math.min(housing, Math.max(0, Math.floor(elapsedSeconds / residentIntervalSeconds)));
    }
  }
  const served = {
    water: Math.min(residents, capacities.water),
    jobs: Math.min(residents, capacities.jobs),
    education: Math.min(residents, capacities.education),
    health: Math.min(residents, capacities.health),
  };
  const wellbeing = residents === 0 ? 0 : Math.round(
    40 + (15 / residents) * (served.water + served.jobs + served.education + served.health),
  );
  return { buildings, housingCapacity, residents, residentIntervalSeconds, catalog, capacities, served, wellbeing };
}

export function constructionPrice(kind: BuildingKind, buildings: TownBuilding[], expansionOwned: boolean): number | TownError {
  if (!expansionOwned) return 'town_requires_expansion';
  const option = catalog[kind];
  if (option.requires && !buildings.some((building) => building.kind === option.requires)) {
    return option.requires === 'road' ? 'town_requires_road' : 'town_requires_cottage';
  }
  if (buildings.filter((building) => building.kind === kind).length >= option.limit) return 'town_building_limit';
  return option.price;
}

export async function constructBuilding(client: PoolClient, playerUid: string, kind: BuildingKind, now: Date) {
  const { rows: [{ building }] } = await client.query<{ building: TownBuilding }>(
    `INSERT INTO farm_town_buildings (player_uid, kind, built_at)
     VALUES ($1, $2, $3) RETURNING ${buildingJson} AS building`,
    [playerUid, kind, now],
  );
  return building;
}

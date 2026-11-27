import { randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';

export const animalSpecies = ['goat', 'chicken'] as const;
export type AnimalSpecies = typeof animalSpecies[number];
type Sex = 'female' | 'male';

export const animalPrices: Record<AnimalSpecies, number> = { goat: 12, chicken: 6 };
export const animalCapacity = 8;
export const animalProduction = {
  goat: { product: 'milk', milliseconds: 90_000 },
  chicken: { product: 'eggs', milliseconds: 60_000 },
} as const;

export type Animal = {
  animalId: string;
  species: AnimalSpecies;
  sex: Sex;
  acquiredAt: string;
  productReadyAt: string | null;
  motherId: string | null;
  fatherId: string | null;
  matureAt: string | null;
};

export type Breeding = {
  motherId: string;
  fatherId: string;
  readyAt: string;
};

const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const animalJson = `jsonb_build_object(
  'animalId', animal_id, 'species', species, 'sex', sex,
  'acquiredAt', ${utc('acquired_at')}, 'productReadyAt', ${utc('product_ready_at')},
  'motherId', mother_id, 'fatherId', father_id, 'matureAt', ${utc('mature_at')})`;

export const animalRosterExpression = `COALESCE((
  SELECT jsonb_agg(${animalJson} ORDER BY acquired_at, animal_id)
  FROM farm_animals WHERE player_uid = player.uid
), '[]'::jsonb)`;

export const breedingExpression = `(
  SELECT jsonb_build_object('motherId', mother_id, 'fatherId', father_id, 'readyAt', ${utc('ready_at')})
  FROM farm_breeding WHERE player_uid = player.uid
)`;

export async function createAnimal(client: PoolClient, playerUid: string, species: AnimalSpecies,
  animals: Animal[], parents?: Breeding, now?: Date): Promise<Animal> {
  const sameSpecies = animals.filter((animal) => animal.species === species);
  const females = sameSpecies.filter((animal) => animal.sex === 'female').length;
  const sex = parents ? (randomInt(2) === 0 ? 'female' : 'male')
    : females * 2 <= sameSpecies.length ? 'female' : 'male';
  const matureAt = parents && now ? new Date(now.getTime() + 120_000) : null;
  const { rows: [{ animal }] } = await client.query<{ animal: Animal }>(
    `INSERT INTO farm_animals (player_uid, species, sex, mother_id, father_id, mature_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${animalJson} AS animal`,
    [playerUid, species, sex, parents?.motherId ?? null, parents?.fatherId ?? null, matureAt],
  );
  return animal;
}

export function eligiblePair(animals: Animal[], first: Animal, second: Animal, now: Date): boolean {
  if (first.animalId === second.animalId || first.species !== second.species || first.sex === second.sex ||
      (first.matureAt && Date.parse(first.matureAt) > now.getTime()) ||
      (second.matureAt && Date.parse(second.matureAt) > now.getTime())) return false;
  const byId = new Map(animals.map((animal) => [animal.animalId, animal]));
  function family(id: string): Set<string> {
    const members = new Set<string>();
    const pending = [id];
    while (pending.length) {
      const member = pending.pop()!;
      if (members.has(member)) continue;
      members.add(member);
      const animal = byId.get(member);
      if (animal?.motherId) pending.push(animal.motherId);
      if (animal?.fatherId) pending.push(animal.fatherId);
    }
    return members;
  }
  const relatives = family(first.animalId);
  return ![...family(second.animalId)].some((id) => relatives.has(id));
}

export async function setProductionTimer(client: PoolClient, playerUid: string, animalId: string, readyAt: Date | null) {
  await client.query(
    'UPDATE farm_animals SET product_ready_at = $3 WHERE player_uid = $1 AND animal_id = $2',
    [playerUid, animalId, readyAt],
  );
}

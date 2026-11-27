import type { PoolClient } from 'pg';

export const animalSpecies = ['goat', 'chicken'] as const;
export type AnimalSpecies = typeof animalSpecies[number];

export const animalPrices: Record<AnimalSpecies, number> = { goat: 12, chicken: 6 };
export const animalCapacity = 8;

export type Animal = {
  animalId: string;
  species: AnimalSpecies;
  acquiredAt: string;
};

export const animalRosterExpression = `COALESCE((
  SELECT jsonb_agg(jsonb_build_object('animalId', animal_id, 'species', species,
    'acquiredAt', to_char(acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY acquired_at, animal_id)
  FROM farm_animals WHERE player_uid = player.uid
), '[]'::jsonb)`;

export async function purchaseAnimal(client: PoolClient, playerUid: string, species: AnimalSpecies): Promise<Animal> {
  const { rows: [animal] } = await client.query<{ animalId: string; species: AnimalSpecies; acquiredAt: Date }>(
    `INSERT INTO farm_animals (player_uid, species) VALUES ($1, $2)
     RETURNING animal_id AS "animalId", species, acquired_at AS "acquiredAt"`,
    [playerUid, species],
  );
  return { ...animal, acquiredAt: animal.acquiredAt.toISOString() };
}

export const townOrderKeys = ['wheat_supply', 'flour_supply', 'milk_supply'] as const;
export type TownOrderKey = typeof townOrderKeys[number];

const offers = {
  wheat_supply: { item: 'wheat', quantity: 2, reward: 8, minimumResidents: 2 },
  flour_supply: { item: 'flour', quantity: 1, reward: 12, minimumResidents: 3 },
  milk_supply: { item: 'milk', quantity: 1, reward: 10, minimumResidents: 4 },
} as const;

export const utcOrderDate = (now: Date) => now.toISOString().slice(0, 10);

export function fulfilledOrdersExpression(date: 'statement_timestamp' | 'parameter') {
  const day = date === 'statement_timestamp' ? "(statement_timestamp() AT TIME ZONE 'UTC')::date" : '$2::date';
  return `COALESCE((
    SELECT jsonb_agg(town_order_key)
    FROM starter_farm_commands
    WHERE player_uid = player.uid AND action = 'fulfil_town_order' AND town_order_date = ${day}
  ), '[]'::jsonb)`;
}

export function orderState(now: Date, residents: number, fulfilled: TownOrderKey[]) {
  return {
    date: utcOrderDate(now),
    offers: townOrderKeys.map((key) => ({
      key,
      ...offers[key],
      unlocked: residents >= offers[key].minimumResidents,
      fulfilled: fulfilled.includes(key),
    })),
  };
}

export type TownOrderError = 'town_order_expired' | 'town_order_locked' | 'town_order_fulfilled' | 'town_order_stock';

export function planTownOrder(key: TownOrderKey, date: string, now: Date, residents: number,
  fulfilled: TownOrderKey[], inventory: { wheat: number; flour: number; milk: number }) {
  if (date !== utcOrderDate(now)) return 'town_order_expired';
  const offer = offers[key];
  if (residents < offer.minimumResidents) return 'town_order_locked';
  if (fulfilled.includes(key)) return 'town_order_fulfilled';
  if (inventory[offer.item] < offer.quantity) return 'town_order_stock';
  return offer;
}

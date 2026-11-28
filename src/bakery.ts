export const bakeryActions = ['buy_bakery', 'start_baking', 'collect_bread', 'sell_bread', 'upgrade_bakery_storage'] as const;
export type BakeryAction = typeof bakeryActions[number];

const price = 24;
const breadPrice = 22;
const durationSeconds = 90;
const storagePrice = 18;
const breadCapacity = (upgraded: boolean) => upgraded ? 12 : 3;
const recipe = { flour: 1, milk: 1, eggs: 1 } as const;

export type Bakery = { readyAt: string | null };
export const bakeryExpression = `(
  SELECT jsonb_build_object('readyAt', to_char(ready_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM farm_bakeries WHERE player_uid = player.uid
)`;

export function bakeryState(bakery: Bakery | null, millOwned: boolean, storageUpgraded = false) {
  return { owned: bakery !== null, millOwned, readyAt: bakery?.readyAt ?? null, price, breadPrice, durationSeconds, recipe, storageUpgraded,
    storagePrice, breadCapacity: breadCapacity(storageUpgraded) };
}

export type BakeryError = 'insufficient_coins' | 'bakery_requires_mill' | 'bakery_already_owned' |
  'bakery_not_owned' | 'bakery_busy' | 'bakery_idle' | 'bakery_ingredients' | 'bread_not_ready' | 'insufficient_bread' | 'bread_storage_full' | 'bakery_storage_already_upgraded';

type BakeryChanges = {
  bakery: Bakery | null;
  coins: number;
  flour: number;
  milk: number;
  eggs: number;
  bread: number;
  upgradeStorage: boolean;
  reason: 'bakery_purchase' | 'bread_sale' | 'bakery_storage_purchase' | null;
};

export function planBakeryAction(action: BakeryAction, bakery: Bakery | null, millOwned: boolean,
  farm: { coins: number; flour: number; milk: number; eggs: number; bread: number; bakery_storage_upgraded: boolean }, now: Date): BakeryChanges | BakeryError {
  const unchanged = { bakery, coins: 0, flour: 0, milk: 0, eggs: 0, bread: 0, upgradeStorage: false, reason: null };
  switch (action) {
    case 'buy_bakery':
      if (bakery) return 'bakery_already_owned';
      if (!millOwned) return 'bakery_requires_mill';
      if (farm.coins < price) return 'insufficient_coins';
      return { ...unchanged, bakery: { readyAt: null }, coins: -price, reason: 'bakery_purchase' };
    case 'start_baking':
      if (!bakery) return 'bakery_not_owned';
      if (bakery.readyAt) return 'bakery_busy';
      if (farm.flour < recipe.flour || farm.milk < recipe.milk || farm.eggs < recipe.eggs) return 'bakery_ingredients';
      return { ...unchanged, bakery: { readyAt: new Date(now.getTime() + durationSeconds * 1000).toISOString() },
        flour: -recipe.flour, milk: -recipe.milk, eggs: -recipe.eggs };
    case 'collect_bread':
      if (!bakery) return 'bakery_not_owned';
      if (!bakery.readyAt) return 'bakery_idle';
      if (now.getTime() < Date.parse(bakery.readyAt)) return 'bread_not_ready';
      if (farm.bread >= breadCapacity(farm.bakery_storage_upgraded)) return 'bread_storage_full';
      return { ...unchanged, bakery: { readyAt: null }, bread: 1 };
    case 'upgrade_bakery_storage':
      if (!bakery) return 'bakery_not_owned';
      if (farm.bakery_storage_upgraded) return 'bakery_storage_already_upgraded';
      if (farm.coins < storagePrice) return 'insufficient_coins';
      return { ...unchanged, coins: -storagePrice, upgradeStorage: true, reason: 'bakery_storage_purchase' };
    case 'sell_bread':
      if (farm.bread < 1) return 'insufficient_bread';
      return { ...unchanged, coins: breadPrice, bread: -1, reason: 'bread_sale' };
  }
}

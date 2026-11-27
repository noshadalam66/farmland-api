export const millActions = ['buy_mill', 'start_milling', 'collect_flour', 'sell_flour'] as const;
export type MillAction = typeof millActions[number];

const millPrice = 15;
const flourPrice = 9;
const wheatPerBatch = 2;
const millingMilliseconds = 60_000;

export type Mill = { readyAt: string | null };
export const millExpression = `(
  SELECT jsonb_build_object('readyAt', to_char(ready_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM farm_grain_mills WHERE player_uid = player.uid
)`;

export function millState(mill: Mill | null) {
  return { owned: mill !== null, readyAt: mill?.readyAt ?? null, price: millPrice,
    flourPrice, wheatPerBatch, durationSeconds: millingMilliseconds / 1000 };
}

export type MillError = 'insufficient_coins' | 'insufficient_crop' | 'insufficient_flour' |
  'mill_already_owned' | 'mill_not_owned' | 'mill_busy' | 'mill_idle' | 'flour_not_ready';

type MillChanges = {
  mill: Mill | null;
  coins: number;
  wheat: number;
  flour: number;
  reason: 'mill_purchase' | 'flour_sale' | null;
};

export function planMillAction(action: MillAction, mill: Mill | null, farm: {
  coins: number; wheat: number; flour: number;
}, now: Date): MillChanges | MillError {
  const unchanged = { mill, coins: 0, wheat: 0, flour: 0, reason: null };
  switch (action) {
    case 'buy_mill':
      if (mill) return 'mill_already_owned';
      if (farm.coins < millPrice) return 'insufficient_coins';
      return { ...unchanged, mill: { readyAt: null }, coins: -millPrice, reason: 'mill_purchase' };
    case 'start_milling':
      if (!mill) return 'mill_not_owned';
      if (mill.readyAt) return 'mill_busy';
      if (farm.wheat < wheatPerBatch) return 'insufficient_crop';
      return { ...unchanged, mill: { readyAt: new Date(now.getTime() + millingMilliseconds).toISOString() },
        wheat: -wheatPerBatch };
    case 'collect_flour':
      if (!mill) return 'mill_not_owned';
      if (!mill.readyAt) return 'mill_idle';
      if (now.getTime() < Date.parse(mill.readyAt)) return 'flour_not_ready';
      return { ...unchanged, mill: { readyAt: null }, flour: 1 };
    case 'sell_flour':
      if (farm.flour < 1) return 'insufficient_flour';
      return { ...unchanged, coins: flourPrice, flour: -1, reason: 'flour_sale' };
  }
}

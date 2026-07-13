import type { TradeSide } from "../trades/math.js";

export type TrackingState = {
  side: TradeSide;
  entryPrice: number;
  mfePrice: number;
  /** Была ли цена хоть раз в плюсе от входа — нужно, чтобы отличить "просадка сразу
   * от входа" от настоящего "было в прибыли, откатило к безубытку". */
  hasBeenInProfit: boolean;
  beCrossed: boolean;
};

/** true, если `price` выгоднее (дальше в сторону тейка), чем `reference`, для данной стороны. */
function isMoreFavorable(side: TradeSide, price: number, reference: number): boolean {
  return side === "long" ? price > reference : price < reference;
}

/** true, если `price` откатилась к цене входа или хуже неё. */
function isBackToOrBeyondEntry(side: TradeSide, price: number, entryPrice: number): boolean {
  return side === "long" ? price <= entryPrice : price >= entryPrice;
}

export function createTrackingState(side: TradeSide, entryPrice: number, initial?: Partial<TrackingState>): TrackingState {
  return {
    side,
    entryPrice,
    mfePrice: initial?.mfePrice ?? entryPrice,
    hasBeenInProfit: initial?.hasBeenInProfit ?? false,
    beCrossed: initial?.beCrossed ?? false,
  };
}

/**
 * Применяет очередной тик цены к состоянию трекинга. Возвращает новое состояние и
 * флаг `changed` — стоит ли персистить (не на каждый тик, только на значимое изменение):
 * новый экстремум MFE или первое пересечение цены обратно к безубытку.
 *
 * "Пересечение безубытка" (docs/RISK_ENGINE.md) — цена сначала ушла в плюс от входа,
 * а затем вернулась к цене входа или хуже. Разовое событие: после первого срабатывания
 * дальше не проверяется.
 */
export function applyPriceTick(state: TrackingState, price: number): { state: TrackingState; changed: boolean } {
  let changed = false;
  let { mfePrice, hasBeenInProfit, beCrossed } = state;

  if (isMoreFavorable(state.side, price, mfePrice)) {
    mfePrice = price;
    changed = true;
  }

  if (!hasBeenInProfit && isMoreFavorable(state.side, price, state.entryPrice)) {
    hasBeenInProfit = true;
  }

  if (hasBeenInProfit && !beCrossed && isBackToOrBeyondEntry(state.side, price, state.entryPrice)) {
    beCrossed = true;
    changed = true;
  }

  return { state: { ...state, mfePrice, hasBeenInProfit, beCrossed }, changed };
}

export type TradeSide = "long" | "short";

/** Пресеты соотношения риск/прибыль из docs/PROJECT.md. */
export const RR_PRESETS = ["1/1", "1/1.5", "1/2", "1/3", "1/4", "1/5", "1/6", "1/7"] as const;
export type RRPreset = (typeof RR_PRESETS)[number];

/** "1/2" → 2 (прибыль вдвое больше риска). Только пресеты из RR_PRESETS — иначе null. */
export function parseRRRatio(preset: string): number | null {
  if (!(RR_PRESETS as readonly string[]).includes(preset)) return null;
  const match = /^1\/(\d+(\.\d+)?)$/.exec(preset);
  if (!match?.[1]) return null;
  return Number(match[1]);
}

/** Сумма риска сделки в USDT: |вход − стоп| × количество монет. */
export function computeRiskUsd(entryPrice: number, slPrice: number, quantity: number): number {
  return Math.abs(entryPrice - slPrice) * quantity;
}

/** Цена тейк-профита от соотношения риск/прибыль и фактической цены входа. */
export function computeTakeProfitPrice(
  entryPrice: number,
  slPrice: number,
  side: TradeSide,
  ratio: number,
): number {
  const riskDistance = Math.abs(entryPrice - slPrice);
  const rewardDistance = riskDistance * ratio;
  return side === "long" ? entryPrice + rewardDistance : entryPrice - rewardDistance;
}

/** SL для лонга должен быть ниже входа, для шорта — выше. */
export function isValidStopLoss(entryPrice: number, slPrice: number, side: TradeSide): boolean {
  return side === "long" ? slPrice < entryPrice : slPrice > entryPrice;
}

/** TP для лонга должен быть выше входа, для шорта — ниже. */
export function isValidTakeProfit(entryPrice: number, tpPrice: number, side: TradeSide): boolean {
  return side === "long" ? tpPrice > entryPrice : tpPrice < entryPrice;
}

/**
 * Результат сделки в R и % по цене закрытия — используется, когда точный реализованный
 * PnL с биржи недоступен (ручное закрытие, резервный путь сверки без ORDER_TRADE_UPDATE).
 * Общая формула для trades/service.ts и realtime/reconcile.ts — раньше дублировалась.
 */
export function computeResultFromPrices(
  side: TradeSide,
  entryPrice: number,
  closePrice: number,
  quantity: number,
  riskUsd: number,
): { resultR: number; resultPct: number } {
  const priceDelta = side === "long" ? closePrice - entryPrice : entryPrice - closePrice;
  const resultR = riskUsd > 0 ? (priceDelta * quantity) / riskUsd : 0;
  const resultPct = entryPrice > 0 ? (priceDelta / entryPrice) * 100 : 0;
  return { resultR, resultPct };
}

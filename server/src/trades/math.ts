export type TradeSide = "long" | "short";

/** Пресеты соотношения риск/прибыль из docs/PROJECT.md. */
export const RR_PRESETS = [
  "1/1",
  "1/1.5",
  "1/2",
  "1/3",
  "1/4",
  "1/5",
  "1/6",
  "1/7",
  "1/8",
  "1/9",
  "1/10",
] as const;
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

/** Фиксированная доля объёма, закрываемая на уровне частичной фиксации (см. docs/PROJECT.md). */
export const PARTIAL_TP_PERCENT = 70;

/**
 * Начиная с этого R/R (пресет 1/5 и выше) частичная фиксация обязательна —
 * дальние тейки без промежуточной фиксации слишком легко «отдают» уже взятую прибыль.
 */
export const PARTIAL_TP_REQUIRED_MIN_RATIO = 5;

/**
 * Потолок R/R для уровня частичной фиксации: не дальше 1/3 от входа.
 * Дальше — уже зона основного тейка; промежуточная фиксация должна быть ближе.
 */
export const PARTIAL_TP_MAX_RATIO = 3;

/** Пресеты цены частичной фиксации (как у TP, но только до 1/3). */
export const PARTIAL_TP_PRESETS = ["1/1", "1/2", "1/3"] as const;

/** Нужна ли частичная фиксация при данном соотношении риск/прибыль основного TP. */
export function requiresPartialTakeProfit(ratio: number): boolean {
  return Number.isFinite(ratio) && ratio >= PARTIAL_TP_REQUIRED_MIN_RATIO;
}

/** Фактическое R/R по ценам входа, SL и целевого уровня (null, если риск нулевой). */
export function computeRiskRewardRatio(entryPrice: number, slPrice: number, targetPrice: number): number | null {
  const risk = Math.abs(entryPrice - slPrice);
  if (!(risk > 0)) return null;
  return Math.abs(targetPrice - entryPrice) / risk;
}

/**
 * Цена частичной фиксации должна лежать строго между входом и основным TP — так частичный
 * ордер срабатывает раньше основного по мере движения цены в прибыль, а не после него.
 */
export function isValidPartialTakeProfit(
  entryPrice: number,
  tpPrice: number,
  partialTpPrice: number,
  side: TradeSide,
): boolean {
  return side === "long"
    ? partialTpPrice > entryPrice && partialTpPrice < tpPrice
    : partialTpPrice < entryPrice && partialTpPrice > tpPrice;
}

/**
 * Частичная фиксация не должна быть дальше 1/3 R от входа (PARTIAL_TP_MAX_RATIO) —
 * даже если основной TP ещё дальше и «между входом и TP» формально выполняется.
 */
export function isPartialTakeProfitWithinMaxRatio(
  entryPrice: number,
  slPrice: number,
  partialTpPrice: number,
): boolean {
  const ratio = computeRiskRewardRatio(entryPrice, slPrice, partialTpPrice);
  return ratio !== null && ratio <= PARTIAL_TP_MAX_RATIO;
}

/**
 * Целевое R/R частичной фиксации, после которого подтягиваем SL на 1/1 (вариант B).
 * Совпадает с потолком partial (1/3).
 */
export const PARTIAL_TP_TRIGGER_MOVE_SL_RATIO = PARTIAL_TP_MAX_RATIO;

/** Новый стоп после partial на 1/3 — защита остатка на +1R. */
export const SL_AFTER_PARTIAL_RATIO = 1;

/**
 * Допуск при сравнении фактического R/R partial с целевым 1/3.
 * 0.2 отделяет 1/3 (3) от 1/2 (2) и 1/1 (1) с запасом на округление цены.
 */
export const PARTIAL_RATIO_MATCH_EPSILON = 0.2;

/** Partial-цена близка к заданному R/R (для правила «только 1/3»). */
export function isPartialTakeProfitNearRatio(
  entryPrice: number,
  slPrice: number,
  partialTpPrice: number,
  targetRatio: number,
  epsilon: number = PARTIAL_RATIO_MATCH_EPSILON,
): boolean {
  const ratio = computeRiskRewardRatio(entryPrice, slPrice, partialTpPrice);
  if (ratio === null) return false;
  return Math.abs(ratio - targetRatio) <= epsilon;
}

/**
 * SL уже на стороне прибыли относительно входа (безубыток или +1R) —
 * значит подтягивание после partial уже сделано (или стоп не исходный защитный).
 */
export function isStopOnProfitSide(entryPrice: number, slPrice: number, side: TradeSide): boolean {
  return side === "long" ? slPrice >= entryPrice : slPrice <= entryPrice;
}

/** Остаток объёма после partial (неотрицательный). */
export function computeRemainderQuantity(totalQuantity: number, partialQuantity: number): number {
  if (!(totalQuantity > 0)) return 0;
  const remainder = totalQuantity - Math.max(0, partialQuantity);
  return remainder > 0 ? remainder : 0;
}

/**
 * Решение: нужно ли после исполненной partial на ~1/3 заменить SL на 1/1.
 * Чистая функция без I/O — покрывается тестами; I/O живёт в trades/service.
 */
export type MoveSlAfterPartialDecision =
  | { action: "skip"; reason: string }
  | { action: "move"; newSlPrice: number; remainderQuantity: number };

export function decideMoveSlAfterPartialOneToThree(input: {
  side: TradeSide;
  entryPrice: number;
  slPrice: number;
  partialTpPrice: number | null;
  partialTpFilledAt: Date | string | null;
  quantity: number;
  partialTpQuantity: number | null;
}): MoveSlAfterPartialDecision {
  if (!input.partialTpFilledAt) {
    return { action: "skip", reason: "частичная фиксация ещё не исполнена" };
  }
  if (input.partialTpPrice === null || !(input.partialTpPrice > 0)) {
    return { action: "skip", reason: "нет цены частичной фиксации" };
  }
  if (!(input.entryPrice > 0) || !(input.slPrice > 0)) {
    return { action: "skip", reason: "нет валидных entry/SL" };
  }
  if (isStopOnProfitSide(input.entryPrice, input.slPrice, input.side)) {
    return { action: "skip", reason: "SL уже на стороне прибыли (уже подтянут)" };
  }
  if (
    !isPartialTakeProfitNearRatio(
      input.entryPrice,
      input.slPrice,
      input.partialTpPrice,
      PARTIAL_TP_TRIGGER_MOVE_SL_RATIO,
    )
  ) {
    return { action: "skip", reason: "частичная фиксация не на R/R ≈ 1/3" };
  }

  const partialQty = input.partialTpQuantity ?? 0;
  const remainderQuantity = computeRemainderQuantity(input.quantity, partialQty);
  if (!(remainderQuantity > 0)) {
    return { action: "skip", reason: "нет остатка объёма для нового SL" };
  }

  const newSlPrice = computeTakeProfitPrice(
    input.entryPrice,
    input.slPrice,
    input.side,
    SL_AFTER_PARTIAL_RATIO,
  );
  return { action: "move", newSlPrice, remainderQuantity };
}

/**
 * Кол-во монет для частичного закрытия — та же точность (кол-во знаков после запятой),
 * что и у объёма всей позиции, иначе биржа отклонит ордер за несоответствие lot size.
 * Остаток (для основного TP) считается вычитанием, а не отдельным round — так сумма
 * partial + remainder всегда точно равна исходному объёму.
 */
export function computePartialTpQuantity(quantity: number, quantityDecimals: number): number {
  const raw = (quantity * PARTIAL_TP_PERCENT) / 100;
  const factor = 10 ** quantityDecimals;
  return Math.floor(raw * factor) / factor;
}

/** Кол-во знаков после запятой у строкового представления количества монет. */
export function decimalsOf(value: string): number {
  const dotIndex = value.indexOf(".");
  return dotIndex === -1 ? 0 : value.length - dotIndex - 1;
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

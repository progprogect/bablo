import {
  DEFAULT_NIGHT_START_HOUR,
  isDayTradeIntoNight,
} from "../risk/tradingDay.js";
import {
  computeRemainderQuantity,
  isSlAtOrBeyondTarget,
  PARTIAL_RATIO_MATCH_EPSILON,
  type TradeSide,
} from "./math.js";

/** Целевой R/R ночного тейка: полная фиксация на 1/1, чтобы не пересиживать ночь. */
export const NIGHT_TP_RATIO = 1;

/**
 * Цена уровня +N R от входа по исходному риску сделки (riskUsd / quantity).
 * Нужна, когда текущий SL уже сдвинут (безубыток / +1R после partial) — от него
 * computeTakeProfitPrice дал бы неверный риск.
 */
export function computeRewardPriceFromRiskUsd(
  entryPrice: number,
  riskUsd: number,
  quantity: number,
  side: TradeSide,
  ratio: number,
): number | null {
  if (!(entryPrice > 0) || !(riskUsd > 0) || !(quantity > 0) || !(ratio >= 0)) return null;
  const riskDistance = riskUsd / quantity;
  if (!(riskDistance > 0)) return null;
  return side === "long"
    ? entryPrice + riskDistance * ratio
    : entryPrice - riskDistance * ratio;
}

export type NightTpDecision =
  | { action: "skip"; reason: string }
  | {
      action: "replace";
      newTpPrice: number;
      quantity: number;
      cancelPartial: boolean;
    }
  /**
   * Цена уже прошла 1/1, но до целевого TP не дошла: тейк не трогаем (пусть отрабатывает
   * план), а стоп подтягиваем на уровень 1/1 — сделка уже не может закончиться хуже +1R.
   */
  | { action: "moveSl"; newSlPrice: number; quantity: number };

export type NightTpDecisionInput = {
  side: TradeSide;
  entryPrice: number;
  slPrice: number;
  riskUsd: number;
  quantity: number;
  tpPrice: number | null;
  /**
   * Текущая рыночная цена. null — не удалось получить: тогда работает прежняя ветка
   * (перенос TP на 1/1), потому что без цены отличить «дошла до 1R» от «не дошла» нельзя.
   */
  currentPrice: number | null;
  partialTpPrice: number | null;
  partialTpQuantity: number | null;
  partialTpFilledAt: Date | string | null;
  nightTpAppliedAt: Date | string | null;
  openedAt: Date;
  now: Date;
  nightStartHour?: number;
  resetHour: number;
  tzOffsetMinutes: number;
};

/** Цена уже дошла до целевого уровня в сторону прибыли (для лонга ≥, для шорта ≤). */
function hasReachedTarget(currentPrice: number, targetPrice: number, side: TradeSide): boolean {
  return side === "long" ? currentPrice >= targetPrice : currentPrice <= targetPrice;
}

/**
 * Решение по ночному правилу для дневной сделки, активной после 01:00 МСК.
 * Чистая функция без I/O. Две ветки, развилка по текущей цене:
 * - цена ещё НЕ дошла до 1/1 → TP переносится на 1/1 × 100% остатка (не пересиживаем ночь);
 * - цена УЖЕ прошла 1/1 → TP остаётся плановым, SL подтягивается на 1/1.
 */
export function decideNightTakeProfit(input: NightTpDecisionInput): NightTpDecision {
  const nightStartHour = input.nightStartHour ?? DEFAULT_NIGHT_START_HOUR;

  if (input.nightTpAppliedAt) {
    return { action: "skip", reason: "ночной TP 1/1 уже применялся" };
  }
  if (
    !isDayTradeIntoNight(
      input.openedAt,
      input.now,
      nightStartHour,
      input.resetHour,
      input.tzOffsetMinutes,
    )
  ) {
    return {
      action: "skip",
      reason: "не ночь или сделка открыта ночью / ещё не дотянула до ночи",
    };
  }
  if (!(input.entryPrice > 0) || !(input.quantity > 0) || !(input.riskUsd > 0)) {
    return { action: "skip", reason: "нет валидных entry/quantity/risk" };
  }
  if (input.tpPrice === null || !(input.tpPrice > 0)) {
    return { action: "skip", reason: "TP ещё не выставлен" };
  }

  const newTpPrice = computeRewardPriceFromRiskUsd(
    input.entryPrice,
    input.riskUsd,
    input.quantity,
    input.side,
    NIGHT_TP_RATIO,
  );
  if (newTpPrice === null) {
    return { action: "skip", reason: "не удалось посчитать цену 1/1" };
  }

  // Если SL уже на 1/1 или дальше — сделка и так защищена на +1R, делать нечего
  // (это же покрывает случай подтянутого стопа после partial 1/3).
  if (isSlAtOrBeyondTarget(input.slPrice, newTpPrice, input.side)) {
    return { action: "skip", reason: "SL уже на 1/1 или дальше — ночное правило не нужно" };
  }

  // Текущий TP уже не дальше 1/1 (равен или ближе к входу) и partial либо нет,
  // либо уже исполнена — поджимать нечего. Если partial ещё висит — всё равно
  // схлопываем в один ордер 100% на 1/1.
  const currentTpRiskDistance = Math.abs(input.tpPrice - input.entryPrice);
  const oneRDistance = Math.abs(newTpPrice - input.entryPrice);
  const tpAlreadyAtOrTighterThanOneR =
    oneRDistance > 0 &&
    currentTpRiskDistance <= oneRDistance * (1 + PARTIAL_RATIO_MATCH_EPSILON / NIGHT_TP_RATIO);
  const partialPending = input.partialTpPrice !== null && !input.partialTpFilledAt;
  if (tpAlreadyAtOrTighterThanOneR && !partialPending) {
    return { action: "skip", reason: "TP уже на 1/1 или ближе, partial не висит" };
  }

  const partialQty = input.partialTpFilledAt ? (input.partialTpQuantity ?? 0) : 0;
  const quantity = input.partialTpFilledAt
    ? computeRemainderQuantity(input.quantity, partialQty)
    : input.quantity;
  if (!(quantity > 0)) {
    return { action: "skip", reason: "нет объёма для ночного правила" };
  }

  // Цена уже прошла 1/1 — план не ломаем: TP остаётся своим, но результат фиксируем
  // стопом на 1/1. Ставить TP на 1/1 здесь нельзя: он оказался бы позади рынка и
  // сработал бы сразу, закрыв сделку в 01:00 вместо того, чтобы дать ей доработать.
  if (
    input.currentPrice !== null &&
    input.currentPrice > 0 &&
    hasReachedTarget(input.currentPrice, newTpPrice, input.side)
  ) {
    return { action: "moveSl", newSlPrice: newTpPrice, quantity };
  }

  return {
    action: "replace",
    newTpPrice,
    quantity,
    cancelPartial: partialPending,
  };
}

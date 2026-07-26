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
    };

export type NightTpDecisionInput = {
  side: TradeSide;
  entryPrice: number;
  slPrice: number;
  riskUsd: number;
  quantity: number;
  tpPrice: number | null;
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

/**
 * Решение: заменить TP на 1/1 × 100% остатка для дневной сделки, ушедшей в ночь.
 * Чистая функция без I/O.
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

  // Если SL уже на 1/1 или дальше — тейк на том же уровне бессмысленен.
  if (isSlAtOrBeyondTarget(input.slPrice, newTpPrice, input.side)) {
    return { action: "skip", reason: "SL уже на 1/1 или дальше — ночной TP не ставим" };
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
    return { action: "skip", reason: "нет объёма для ночного TP" };
  }

  return {
    action: "replace",
    newTpPrice,
    quantity,
    cancelPartial: partialPending,
  };
}

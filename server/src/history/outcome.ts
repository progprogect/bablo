import { isStopOnProfitSide, type TradeSide } from "../trades/math.js";

/**
 * Фактический исход закрытой сделки — по экономике, а не по типу сработавшего ордера.
 *
 * Единый источник правды для всей статистики: месячная разбивка TP/SL/БУ, инсайты
 * (прибыльные часы, % прибыльности), дневные лимиты риск-движка и подпись в истории.
 * Иначе одно и то же закрытие где-то считалось бы тейком, а где-то стопом.
 */
export type TradeOutcome = "tp" | "sl" | "be" | "other";

/** |resultR| в этих пределах — безубыток: комиссии и проскальзывание стопа на цене входа. */
export const BREAKEVEN_EPSILON_R = 0.05;

export type TradeForOutcome = {
  closeReason: string | null;
  entryPrice: number | null;
  slPrice: number | null;
  side: string;
  /**
   * Ручной оверрайд исхода из админки: "tp" | "sl" | "be". null/отсутствует — авто.
   * Главнее любых авто-правил: если пользователь сказал, что сделка была по тейку,
   * значит она тейк везде — в статистике, инсайтах и дневных лимитах.
   */
  statsOutcome?: string | null;
};

/** Значения, которые допустимо задать вручную в админке. */
export const MANUAL_OUTCOMES = ["tp", "sl", "be"] as const;

export function isManualOutcome(value: unknown): value is TradeOutcome {
  return typeof value === "string" && (MANUAL_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Стоп стоял на стороне прибыли (вход или выше/ниже него) и сделка закрылась в плюс —
 * это не сработавший план защиты, а СОЗНАТЕЛЬНО зафиксированная прибыль: ночное
 * подтягивание SL на 1/1 или правило «ход ≤ 2R» после частичной фиксации.
 *
 * Держать такое закрытие в «стопах» неверно вдвойне: в статистике месяц выглядел бы
 * хуже, чем был, а дневной лимит «2 стопа за день» останавливал бы торговлю после двух
 * прибыльных сделок.
 */
export function isProfitLockedStop(trade: TradeForOutcome, resultR: number): boolean {
  if (trade.closeReason !== "sl") return false;
  if (!(resultR > BREAKEVEN_EPSILON_R)) return false;
  const entry = trade.entryPrice;
  const sl = trade.slPrice;
  if (entry === null || sl === null) return false;
  if (trade.side !== "long" && trade.side !== "short") return false;
  return isStopOnProfitSide(entry, sl, trade.side as TradeSide);
}

/**
 * Близость resultR к нулю сама по себе не значит БУ: стоп с исходным защитным SL
 * и «нулевым» R (баг rp=0 от биржи) должен оставаться SL в разбивке TP/SL/Б/У.
 * БУ — только если стоп уже на стороне прибыли (вход / +1R) или closeReason не sl.
 */
export function isBreakevenClose(trade: TradeForOutcome, resultR: number): boolean {
  if (Math.abs(resultR) > BREAKEVEN_EPSILON_R) return false;
  if (trade.closeReason !== "sl") return true;
  const entry = trade.entryPrice;
  const sl = trade.slPrice;
  if (entry !== null && sl !== null && (trade.side === "long" || trade.side === "short")) {
    return isStopOnProfitSide(entry, sl, trade.side as TradeSide);
  }
  // Нет данных о SL — оставляем прежнее поведение (считать БУ по |R|).
  return true;
}

/**
 * Исход сделки для статистики:
 * - ручной оверрайд из админки (`statsOutcome`) — главнее всего;
 * - `tp` — закрытие по тейку ИЛИ по стопу, уведённому в прибыль (см. isProfitLockedStop);
 * - `be` — результат в пределах ±0.05R (стоп на входе / ручное закрытие в ноль);
 * - `sl` — реальный стоп: план защиты сработал в убыток;
 * - `other` — закрыто вручную или на бирже мимо приложения (`manual` / `external`),
 *   без явной классификации в админке.
 */
export function resolveTradeOutcome(trade: TradeForOutcome, resultR: number): TradeOutcome {
  if (isManualOutcome(trade.statsOutcome)) return trade.statsOutcome;
  if (isBreakevenClose(trade, resultR)) return "be";
  if (trade.closeReason === "tp") return "tp";
  if (trade.closeReason === "sl") return isProfitLockedStop(trade, resultR) ? "tp" : "sl";
  return "other";
}

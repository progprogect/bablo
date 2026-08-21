import { isStopOnProfitSide, parseRRRatio, type TradeSide } from "../trades/math.js";

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
 * Закрытие по стопу с ПОЛОЖИТЕЛЬНЫМ результатом — это зафиксированная прибыль, а не
 * сработавший план защиты: либо стоп был уведён в прибыль (ночное правило 1/1,
 * «ход ≤ 2R» после partial), либо прибыль уже набрана частичными фиксациями — в том
 * числе изменёнными прямо на бирже, о которых приложение не знает, — и остаток по
 * стопу её не съел.
 *
 * Положение стопа НЕ проверяем (решение от 20.08.2026; раньше требовался стоп на
 * стороне прибыли): защитный стоп в плюс закрыться не может — для лонга он ниже входа
 * и исполняется не лучше триггера, поэтому положительный R на стопе сам по себе
 * означает зафиксированную прибыль. Знак решает всё. Баг rp=0 сюда не просачивается:
 * он даёт ноль, а не плюс, и ноль остаётся в ветке безубытка/стопа.
 *
 * Держать такое закрытие в «стопах» неверно вдвойне: месяц в статистике выглядел бы
 * хуже, чем был, а дневной лимит «2 стопа за день» останавливал бы торговлю после
 * двух прибыльных сделок.
 */
export function isProfitLockedStop(trade: TradeForOutcome, resultR: number): boolean {
  if (trade.closeReason !== "sl") return false;
  return resultR > BREAKEVEN_EPSILON_R;
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

/** Значение statsRrPreset, означающее «не учитывать в сетке R». */
export const STATS_RR_PRESET_NONE = "none";

/**
 * Шаг R в статистике — **0.5**: целое или половина (1.12R → 1R, 1.26R → 1.5R, 2.95R → 3R).
 * Округление делается ДО агрегации.
 *
 * Иначе в карточке месяца оказывается «округление суммы», а пользователь складывает
 * «сумму округлений» по карточкам сделок — и числа не сходятся (три сделки по 1.04R
 * показываются как 1R каждая, а сумма выходит 3.1R вместо 3R). Поэтому единица учёта —
 * уже округлённый R сделки, и он один для всех потребителей: месячная статистика,
 * инсайты, карточка в Истории.
 *
 * НЕ применяется к деньгам (USDT, % к депозиту) и к риск-движку: там нужна полная
 * точность — эквити прошлых месяцев восстанавливается из фактического PnL, а дневные
 * лимиты не должны срабатывать из-за округления (−1.96R не то же самое, что −2R).
 */
const STATS_R_STEP = 0.5;

export function roundStatsR(value: number): number {
  return Math.round(value / STATS_R_STEP) * STATS_R_STEP;
}

/**
 * R сделки ДЛЯ СТАТИСТИКИ — округлённый с шагом 0.5 (см. roundStatsR). По умолчанию это
 * фактический `resultR`. Если в админке задан
 * столбец R (`statsRrPreset`), то он и есть источник правды для R-метрик: месячная сумма R,
 * «+R / −R», винрейт, инсайты. Знак берётся от исхода: тейк → +ratio, стоп → −ratio;
 * для БУ и неклассифицированных закрытий остаётся факт.
 *
 * На ДЕНЬГИ (USDT в истории, % к депозиту) не влияет — и это осознанно. Эквити прошлых
 * месяцев восстанавливается вычитанием фактического PnL из текущего баланса, поэтому там
 * нужен реальный результат, иначе арифметика разойдётся с балансом на бирже. Расхождение
 * «план 2R, а в статистике 20R» обычно и означает неверно записанный риск: деньги
 * (`resultR × riskUsd`) при этом верные, врёт только R.
 */
export function resolveStatsResultR(
  trade: { statsRrPreset?: string | null; resultR: number | null },
  outcome: TradeOutcome,
): number | null {
  const factual = trade.resultR === null ? null : roundStatsR(trade.resultR);
  const preset = trade.statsRrPreset;
  if (preset == null || preset === "" || preset === STATS_RR_PRESET_NONE) {
    return factual;
  }
  const ratio = parseRRRatio(preset);
  if (ratio === null) return factual;
  if (outcome === "tp") return roundStatsR(ratio);
  if (outcome === "sl") return roundStatsR(-ratio);
  return factual;
}

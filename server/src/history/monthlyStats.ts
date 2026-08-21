import {
  PARTIAL_RATIO_MATCH_EPSILON,
  PARTIAL_TP_PRESETS,
  parseRRRatio,
  RR_PRESETS,
  type TradeSide,
} from "../trades/math.js";
import { getLocalDateKey } from "../risk/tradingDay.js";
import {
  isBreakevenClose,
  resolveStatsResultR,
  resolveTradeOutcome,
  roundStatsR,
  STATS_RR_PRESET_NONE,
  type TradeForOutcome,
} from "./outcome.js";

export { STATS_RR_PRESET_NONE };

export type MonthlyStatTradeInput = {
  openedAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
  resultR: number | null;
  riskUsd: number | null;
  rrPreset: string | null;
  entryPrice?: number | null;
  slPrice?: number | null;
  side?: TradeSide | string | null;
  /** Ручной оверрайд исхода из админки (тейк/стоп/БУ) — см. history/outcome.ts. */
  statsOutcome?: string | null;
  quantity?: number | null;
  partialTpPrice?: number | null;
  partialTpFilledAt?: Date | string | null;
  /** Ночной TP 1/1 применён — см. trades/nightTp.ts. */
  nightTpAppliedAt?: Date | string | null;
  /**
   * Ручной оверрайд сетки R (админка): null/undefined — авто;
   * "none" — не учитывать; иначе пресет RR_PRESETS.
   */
  statsRrPreset?: string | null;
};

export type MonthlyRRPresetCount = { preset: string; count: number };

export type MonthlyStat = {
  year: number;
  month: number; // 1–12
  totalTrades: number;
  tpCount: number;
  slCount: number;
  beCount: number;
  otherCount: number;
  winRate: number; // 0..1
  sumR: number;
  /** Сумма resultR только по прибыльным сделкам (resultR > 0) — "сколько R заработано". */
  sumPositiveR: number;
  /** Сумма resultR только по убыточным сделкам (resultR < 0, само число отрицательное) — "сколько R потеряно". */
  sumNegativeR: number;
  /** % к депозиту за месяц (см. computeBaselineEquity ниже). Null, только если ни одного снимка эквити ещё не было вообще. */
  resultPct: number | null;
  tradingDays: number;
  daysWithoutTrading: number;
  daysInMonth: number;
  /** Разбивка по пресетам RR_PRESETS: полные тейки + исполненные partial (см. resolveMonthlyRrPresetBucket). */
  byRRPreset: MonthlyRRPresetCount[];
};

/** @deprecated Используйте isBreakevenClose из history/outcome.ts — единый источник правды. */
export function isMonthlyBreakevenClose(trade: MonthlyStatTradeInput, resultR: number): boolean {
  return isBreakevenClose(toOutcomeInput(trade), resultR);
}

/** Поля, по которым определяется исход сделки (history/outcome.ts). */
function toOutcomeInput(trade: MonthlyStatTradeInput): TradeForOutcome {
  return {
    closeReason: trade.closeReason,
    entryPrice: trade.entryPrice ?? null,
    slPrice: trade.slPrice ?? null,
    side: trade.side ?? "",
    statsOutcome: trade.statsOutcome ?? null,
  };
}

/**
 * R/R частичной фиксации от исходного риска сделки (riskUsd / quantity),
 * даже если SL уже сдвинут на вход / +1R.
 */
export function computePartialRatioFromRiskUsd(
  entryPrice: number,
  partialTpPrice: number,
  riskUsd: number,
  quantity: number,
): number | null {
  if (!(entryPrice > 0) || !(partialTpPrice > 0) || !(riskUsd > 0) || !(quantity > 0)) return null;
  const riskDistance = riskUsd / quantity;
  if (!(riskDistance > 0)) return null;
  return Math.abs(partialTpPrice - entryPrice) / riskDistance;
}

/** Ближайший пресет partial (1/1 · 1/2 · 1/3) к фактическому R/R, иначе null. */
export function matchPartialPreset(ratio: number): (typeof PARTIAL_TP_PRESETS)[number] | null {
  let best: (typeof PARTIAL_TP_PRESETS)[number] | null = null;
  let bestDelta = Infinity;
  for (const preset of PARTIAL_TP_PRESETS) {
    const target = parseRRRatio(preset);
    if (target === null) continue;
    const delta = Math.abs(ratio - target);
    if (delta <= PARTIAL_RATIO_MATCH_EPSILON && delta < bestDelta) {
      best = preset;
      bestDelta = delta;
    }
  }
  return best;
}

/** Ближайший пресет из полной сетки R/R (1/1…1/10) к фактическому отношению, иначе null. */
export function matchRrPreset(ratio: number): string | null {
  let best: string | null = null;
  let bestDelta = Infinity;
  for (const preset of RR_PRESETS) {
    const target = parseRRRatio(preset);
    if (target === null) continue;
    const delta = Math.abs(ratio - target);
    if (delta <= PARTIAL_RATIO_MATCH_EPSILON && delta < bestDelta) {
      best = preset;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * В какой столбец сетки 1R…10R попадает сделка:
 * - ручной оверрайд из админки (statsRrPreset) — главный приоритет;
 * - исполненная partial (известная приложению) → пресет partial (1/2, 1/3…);
 * - любой исход «тейк» (обычный TP, стоп в плюсе — ночной 1/1, partial мимо приложения)
 *   → пресет по ФАКТИЧЕСКИ достигнутому R: тейк на +2.09R при плане 1/3 идёт в столбец
 *   2R, стоп на 1/1 — в 1R. Если достигнутый R ни к одному уровню сетки не близок —
 *   откат на плановый пресет, чтобы сделка не выпала из сетки совсем;
 * - реальный стоп / без тейка → null.
 */

export function resolveMonthlyRrPresetBucket(trade: MonthlyStatTradeInput): string | null {
  if (trade.statsRrPreset != null) {
    if (trade.statsRrPreset === STATS_RR_PRESET_NONE || trade.statsRrPreset === "") {
      return null;
    }
    return trade.statsRrPreset;
  }

  if (trade.partialTpFilledAt != null) {
    const entry = trade.entryPrice ?? null;
    const partialPrice = trade.partialTpPrice ?? null;
    const riskUsd = trade.riskUsd ?? null;
    const quantity = trade.quantity ?? null;
    if (entry !== null && partialPrice !== null && riskUsd !== null && quantity !== null) {
      const ratio = computePartialRatioFromRiskUsd(entry, partialPrice, riskUsd, quantity);
      if (ratio !== null) {
        const preset = matchPartialPreset(ratio);
        if (preset) return preset;
      }
    }
  }

  // Дальше в сетку идут только тейки — по ФАКТИЧЕСКОМУ исходу, включая ручной оверрайд
  // из админки: помечена стопом → в сетку не попадает, помечена тейком → попадает.
  const resultR = trade.resultR ?? 0;
  const outcomeInput = toOutcomeInput(trade);
  if (resolveTradeOutcome(outcomeInput, resultR) !== "tp") {
    return null;
  }

  // Тейк (в т.ч. стоп, закрытый в плюс): столбец по ФАКТУ, а не по плану. Плановый
  // пресет — только запасной вариант, если достигнутый R не попадает в сетку.
  const achieved = resolveStatsResultR(trade, "tp") ?? resultR;
  if (achieved > 0) {
    const byFact = matchRrPreset(achieved);
    if (byFact) return byFact;
  }
  return trade.rrPreset ?? null;
}

/** Авто-бакет без учёта statsRrPreset — чтобы в админке показать «сейчас было бы». */
export function resolveAutoMonthlyRrPresetBucket(trade: MonthlyStatTradeInput): string | null {
  return resolveMonthlyRrPresetBucket({ ...trade, statsRrPreset: null });
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseDateKey(dateKey: string): { year: number; month: number; day: number } {
  const parts = dateKey.split("-").map(Number);
  return { year: parts[0]!, month: parts[1]!, day: parts[2]! };
}

/** Последний известный снимок эквити — точка отсчёта для восстановления баланса прошлых месяцев (см. computeBaselineEquity). */
export type EquityAnchor = { date: string; equity: number };

/** Ручное пополнение (amountUsd > 0) или вывод (amountUsd < 0) средств — см. db/repositories/equityAdjustments.ts. */
export type EquityAdjustmentInput = { date: string; amountUsd: number };

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Восстанавливает баланс на начало месяца (monthStartKey), отталкиваясь от последнего
 * известного снимка эквити (anchor) и "откручивая" от него назад реализованный PnL всех
 * сделок и ручные пополнения/выводы за прошедший период: PnL и пополнения увеличивают
 * эквити, поэтому чтобы получить более РАННИЙ баланс, их нужно вычесть из текущего.
 * Работает и в обратную сторону (monthStartKey после даты якоря) — на практике не
 * встречается, так как якорь всегда актуальнее любого начала месяца, но так функция не
 * даёт неверный результат, если это условие когда-нибудь не выполнится.
 */
function computeBaselineEquity(
  monthStartKey: string,
  anchor: EquityAnchor,
  trades: MonthlyStatTradeInput[],
  adjustments: EquityAdjustmentInput[],
  tzOffsetMinutes: number,
): number {
  if (monthStartKey === anchor.date) return anchor.equity;

  const isPast = monthStartKey < anchor.date;
  const rangeStart = isPast ? monthStartKey : anchor.date;
  const rangeEnd = isPast ? anchor.date : monthStartKey;

  let pnlUsd = 0;
  for (const trade of trades) {
    if (trade.resultR === null || trade.riskUsd === null || !trade.closedAt) continue;
    const closedKey = getLocalDateKey(trade.closedAt, tzOffsetMinutes);
    if (closedKey >= rangeStart && closedKey < rangeEnd) {
      pnlUsd += trade.resultR * trade.riskUsd;
    }
  }

  let adjustmentsUsd = 0;
  for (const adjustment of adjustments) {
    if (adjustment.date >= rangeStart && adjustment.date < rangeEnd) {
      adjustmentsUsd += adjustment.amountUsd;
    }
  }

  return isPast ? anchor.equity - pnlUsd - adjustmentsUsd : anchor.equity + pnlUsd + adjustmentsUsd;
}

/**
 * Месячная статистика для вкладки "Статистика" в Истории (docs/PROJECT.md). Группируем
 * по месяцу ЗАКРЫТИЯ сделки (closedAt) — результат месяца формируется в момент, когда
 * сделка фактически завершилась. "Торговые дни" внутри месяца считаем по тому же
 * closedAt, чтобы не было утечки дней за границы месяца при позициях, держащихся через
 * полночь 31/1 числа.
 *
 * % к депозиту (resultPct) считается не по снимку РОВНО на начало месяца (такого снимка
 * для прошлых месяцев может не быть — таблица снимков молодая), а восстановлением от
 * последнего известного снимка (anchor) назад через накопленный PnL сделок и ручные
 * пополнения/выводы (adjustments) — см. computeBaselineEquity(). anchor = null (снимков
 * ещё не было ни одного) — resultPct недоступен для всех месяцев.
 */
export function computeMonthlyStats(
  trades: MonthlyStatTradeInput[],
  tzOffsetMinutes: number,
  anchor: EquityAnchor | null,
  adjustments: EquityAdjustmentInput[] = [],
  today: Date = new Date(),
): MonthlyStat[] {
  type Bucket = {
    year: number;
    month: number;
    trades: MonthlyStatTradeInput[];
    tradingDays: Set<string>;
  };
  const byMonth = new Map<string, Bucket>();

  for (const trade of trades) {
    if (trade.resultR === null || !trade.closedAt) continue;
    const closedKey = getLocalDateKey(trade.closedAt, tzOffsetMinutes);
    const { year, month } = parseDateKey(closedKey);
    const key = monthKey(year, month);
    let bucket = byMonth.get(key);
    if (!bucket) {
      bucket = { year, month, trades: [], tradingDays: new Set() };
      byMonth.set(key, bucket);
    }
    bucket.trades.push(trade);
    bucket.tradingDays.add(closedKey);
  }

  const todayKey = parseDateKey(getLocalDateKey(today, tzOffsetMinutes));

  const result: MonthlyStat[] = [];
  for (const bucket of byMonth.values()) {
    const { year, month, trades: monthTrades, tradingDays } = bucket;

    let tpCount = 0;
    let slCount = 0;
    let beCount = 0;
    let otherCount = 0;
    let winCount = 0;
    let sumR = 0;
    let sumPositiveR = 0;
    let sumNegativeR = 0;
    let sumUsd = 0;
    const byRRPresetCounts = new Map<string, number>();

    for (const trade of monthTrades) {
      const factualR = trade.resultR!;

      // Исход по экономике сделки: стоп, уведённый в прибыль, — это тейк, а не стоп
      // (см. history/outcome.ts).
      const outcome = resolveTradeOutcome(toOutcomeInput(trade), factualR);

      // R-метрики считаем по статистическому R: он уже округлён до десятых, поэтому
      // сумма в карточке месяца сходится со суммой R по карточкам сделок. Если в админке
      // задан столбец R, он и есть правда для суммы R, «+R / −R» и винрейта. Деньги
      // (sumUsd → % к депозиту) остаются фактическими — см. resolveStatsResultR.
      const resultR = resolveStatsResultR(trade, outcome) ?? roundStatsR(factualR);
      sumR += resultR;
      if (trade.riskUsd !== null) {
        sumUsd += factualR * trade.riskUsd;
      }
      if (resultR > 0) {
        winCount += 1;
        sumPositiveR += resultR;
      } else if (resultR < 0) {
        sumNegativeR += resultR;
      }
      if (outcome === "be") {
        beCount += 1;
      } else if (outcome === "tp") {
        tpCount += 1;
      } else if (outcome === "sl") {
        slCount += 1;
      } else {
        otherCount += 1;
      }

      const rrBucket = resolveMonthlyRrPresetBucket(trade);
      if (rrBucket) {
        byRRPresetCounts.set(rrBucket, (byRRPresetCounts.get(rrBucket) ?? 0) + 1);
      }
    }

    const totalTrades = monthTrades.length;
    const totalDaysInMonth = daysInMonth(year, month);
    const isCurrentMonth = todayKey.year === year && todayKey.month === month;
    const daysElapsed = isCurrentMonth ? todayKey.day : totalDaysInMonth;

    const monthStartKey = `${year}-${pad2(month)}-01`;
    const equityBaseline = anchor
      ? computeBaselineEquity(monthStartKey, anchor, trades, adjustments, tzOffsetMinutes)
      : null;
    const resultPct = equityBaseline && equityBaseline > 0 ? (sumUsd / equityBaseline) * 100 : null;

    result.push({
      year,
      month,
      totalTrades,
      tpCount,
      slCount,
      beCount,
      otherCount,
      winRate: totalTrades > 0 ? winCount / totalTrades : 0,
      sumR,
      sumPositiveR,
      sumNegativeR,
      resultPct,
      tradingDays: tradingDays.size,
      daysWithoutTrading: Math.max(daysElapsed - tradingDays.size, 0),
      daysInMonth: totalDaysInMonth,
      byRRPreset: RR_PRESETS.map((preset) => ({
        preset,
        count: byRRPresetCounts.get(preset) ?? 0,
      })),
    });
  }

  result.sort((a, b) => (b.year !== a.year ? b.year - a.year : b.month - a.month));
  return result;
}

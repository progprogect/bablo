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

/**
 * Пресеты, отображаемые в сетке R месячной карточки — только до 1/4 (решение от
 * 21.08.2026): при R/R 1/5+ обязательна частичная фиксация ≤1/3, и такая сделка ложится
 * в сетку по пресету partial — столбцы 5R/6R стояли вечными нулями.
 */
export const STATS_GRID_PRESETS = ["1/1", "1/1.5", "1/2", "1/3", "1/4"] as const;

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
  /**
   * % за месяц по фактическому изменению депозита:
   * (конец − начало − записанные пополнения/выводы) / начало. Незакрытый месяц — до
   * «сейчас». Включает комиссии, funding и торговлю мимо приложения, поэтому НЕ равен
   * сумме PnL сделок / депозит (так считалось до 31.08.2026 и расходилось с реальностью).
   * Null — снимков эквити ещё не было, границы восстановить не из чего.
   */
  resultPct: number | null;
  tradingDays: number;
  daysWithoutTrading: number;
  daysInMonth: number;
  /** Разбивка по пресетам RR_PRESETS: полные тейки + исполненные partial (см. resolveMonthlyRrPresetBucket). */
  byRRPreset: MonthlyRRPresetCount[];
  /**
   * Депозит на начало месяца — от БЛИЖАЙШЕГО к границе реального снимка эквити
   * (снимок ровно на 1-е число берётся как есть; иначе от соседнего снимка
   * докручивается PnL/пополнения за зазор — computeBaselineEquity). Null — снимков ещё не было.
   */
  startEquity: number | null;
  /**
   * Депозит на конец месяца; для текущего месяца — сам якорный снимок (сегодняшний факт).
   * Конец НЕ обязан сходиться с «начало + результат сделок»: ручные пополнения/выводы
   * (adjustmentsUsd) меняют депозит отдельно от торговли.
   */
  endEquity: number | null;
  /**
   * true — значение взято из РЕАЛЬНОГО снимка на эту дату; false — восстановлено откруткой
   * от соседнего снимка и потому приблизительно (открутка не знает комиссий и funding).
   * UI показывает такие значения как «≈» и не строит на них сверку с фактом биржи.
   */
  startEquityExact: boolean;
  endEquityExact: boolean;
  /**
   * Баланс без нереализованного PnL на границах — только из ТОЧНЫХ снимков (иначе null).
   * Именно с ним сходятся начисления BingX, поэтому сверка месяца считается по нему.
   */
  startBalance: number | null;
  endBalance: number | null;
  /** Сумма ручных пополнений/выводов за месяц (пополнения > 0, выводы < 0). */
  adjustmentsUsd: number;
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

/**
 * UTC-границы локального месяца [from, to) — для выборки сделок месяца из БД той же
 * логикой, что и группировка статистики ниже (месяц берётся из getLocalDateKey по
 * closedAt в локальной таймзоне): сделка, закрытая 31.07 в 23:30 UTC при UTC+3,
 * локально уже августовская и должна попадать и в карточку августа, и в его детализацию.
 */
export function localMonthUtcRange(
  year: number,
  month: number,
  tzOffsetMinutes: number,
): { from: Date; to: Date } {
  return {
    from: new Date(Date.UTC(year, month - 1, 1) - tzOffsetMinutes * 60_000),
    to: new Date(Date.UTC(year, month, 1) - tzOffsetMinutes * 60_000),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseDateKey(dateKey: string): { year: number; month: number; day: number } {
  const parts = dateKey.split("-").map(Number);
  return { year: parts[0]!, month: parts[1]!, day: parts[2]! };
}

/**
 * Снимок депозита за день. `equity` — как показывает BingX (включает нереализованный PnL
 * открытых позиций), `balance` — без него; с начислениями BingX сходится именно balance,
 * поэтому сверка месяца идёт по нему. balance = null у снимков до 30.08.2026.
 */
export type EquityAnchor = { date: string; equity: number; balance?: number | null };

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
 *
 * ВАЖНО — результат ПРИБЛИЗИТЕЛЬНЫЙ, и на зазоре в недели ошибка большая: комиссии биржи
 * и funding здесь не откручиваются (их нет в trades), а за месяц активной торговли они
 * набегают на десятки процентов депозита. Поэтому значение, полученное откруткой,
 * помечается флагом `exact: false` — UI показывает его как «≈» и не строит на нём сверку
 * с фактом биржи (баг найден 30.08.2026: сверка на восстановленных границах показывала
 * «не сходится на ~95 USDT», хотя это была ошибка самой открутки, а не потеря данных).
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
  snapshots: EquityAnchor[] = [],
): MonthlyStat[] {
  // Якорь для границы месяца — БЛИЖАЙШИЙ к ней реальный снимок (решение от 30.08.2026;
  // раньше всё восстанавливалось от одного последнего снимка, и «конец = начало + PnL +
  // записанные пополнения» сходилось по построению — незанесённое в админку пополнение
  // было невозможно увидеть, оно молча искажало все прошлые месяцы). Ближайший снимок
  // локализует дрейф зазором в дни, а снимок ровно на границе делает цифру фактом.
  const boundarySnapshots = snapshots.length > 0 ? snapshots : anchor ? [anchor] : [];
  function nearestAnchor(boundaryKey: string): EquityAnchor | null {
    let before: EquityAnchor | null = null;
    let after: EquityAnchor | null = null;
    for (const snapshot of boundarySnapshots) {
      if (snapshot.date <= boundaryKey) {
        if (!before || snapshot.date > before.date) before = snapshot;
      } else if (!after || snapshot.date < after.date) {
        after = snapshot;
      }
    }
    return before ?? after;
  }
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
    const nextMonthStartKey =
      month === 12 ? `${year + 1}-01-01` : `${year}-${pad2(month + 1)}-01`;
    const startAnchor = nearestAnchor(monthStartKey);
    const startEquityExact = startAnchor?.date === monthStartKey;
    const equityBaseline = startAnchor
      ? computeBaselineEquity(monthStartKey, startAnchor, trades, adjustments, tzOffsetMinutes)
      : null;

    // Конец месяца: последний снимок внутри текущего месяца — это и есть сегодняшний факт;
    // для прошлых месяцев конец = начало следующего месяца (от ближайшего к нему снимка).
    let endEquity: number | null = null;
    let endEquityExact = false;
    let endAnchor: EquityAnchor | null = null;
    if (isCurrentMonth && anchor && anchor.date >= monthStartKey && anchor.date < nextMonthStartKey) {
      endEquity = anchor.equity;
      endEquityExact = true; // сегодняшний снимок — факт, откручивать нечего
      endAnchor = anchor;
    } else {
      // Прошлый месяц считаем до его конца, даже если последний снимок лежит внутри него
      // (приложение долго не открывали): иначе «конец месяца» замер бы на дате снимка.
      endAnchor = nearestAnchor(nextMonthStartKey);
      endEquityExact = endAnchor?.date === nextMonthStartKey;
      endEquity = endAnchor
        ? computeBaselineEquity(nextMonthStartKey, endAnchor, trades, adjustments, tzOffsetMinutes)
        : null;
    }

    // Баланс — только из точных снимков: откручивать его тем же способом бессмысленно
    // (та же слепота к комиссиям), а сверка с биржей на приблизительных числах врёт.
    const startBalance =
      startEquityExact && typeof startAnchor?.balance === "number" ? startAnchor.balance : null;
    const endBalance =
      endEquityExact && typeof endAnchor?.balance === "number" ? endAnchor.balance : null;

    let monthAdjustmentsUsd = 0;
    for (const adjustment of adjustments) {
      if (adjustment.date >= monthStartKey && adjustment.date < nextMonthStartKey) {
        monthAdjustmentsUsd += adjustment.amountUsd;
      }
    }

    /**
     * % за месяц — по ФАКТИЧЕСКОМУ изменению депозита (решение от 31.08.2026; раньше
     * считалось «сумма PnL сделок / депозит на начало», из-за чего процент не сходился
     * с реальным движением счёта: в нём не было комиссий, funding и торговли мимо
     * приложения — за август они превращали +48 USDT «по сделкам» в −40 на депозите).
     *
     * Записанные в админке пополнения/выводы вычитаются: они меняют депозит, но не
     * являются результатом торговли — иначе пополнение выглядело бы прибылью месяца.
     * Незакрытый месяц считается до «сейчас» (последний снимок), закрытый — до начала
     * следующего.
     */
    const resultPct =
      equityBaseline !== null && equityBaseline > 0 && endEquity !== null
        ? ((endEquity - equityBaseline - monthAdjustmentsUsd) / equityBaseline) * 100
        : null;

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
      byRRPreset: STATS_GRID_PRESETS.map((preset) => ({
        preset,
        count: byRRPresetCounts.get(preset) ?? 0,
      })),
      startEquity: equityBaseline,
      endEquity,
      startEquityExact,
      endEquityExact,
      startBalance,
      endBalance,
      adjustmentsUsd: monthAdjustmentsUsd,
    });
  }

  result.sort((a, b) => (b.year !== a.year ? b.year - a.year : b.month - a.month));
  return result;
}

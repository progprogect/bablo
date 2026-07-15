import { RR_PRESETS } from "../trades/math.js";
import { getLocalDateKey } from "../risk/tradingDay.js";

export type MonthlyStatTradeInput = {
  openedAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
  resultR: number | null;
  riskUsd: number | null;
  rrPreset: string | null;
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
  /** Разбивка закрытых по тейку сделок по всем пресетам RR_PRESETS (включая пресеты с нулём сделок за месяц). */
  byRRPreset: MonthlyRRPresetCount[];
};

/** Сделка считается закрытой "в безубыток", если |resultR| в пределах этого допуска — учитывает комиссии/проскальзывание у стопа, выставленного на цену входа. */
const BREAKEVEN_EPSILON_R = 0.05;

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
      const resultR = trade.resultR!;
      sumR += resultR;
      if (trade.riskUsd !== null) {
        sumUsd += resultR * trade.riskUsd;
      }
      if (resultR > 0) {
        winCount += 1;
        sumPositiveR += resultR;
      } else if (resultR < 0) {
        sumNegativeR += resultR;
      }

      if (Math.abs(resultR) <= BREAKEVEN_EPSILON_R) {
        beCount += 1;
      } else if (trade.closeReason === "tp") {
        tpCount += 1;
      } else if (trade.closeReason === "sl") {
        slCount += 1;
      } else {
        otherCount += 1;
      }

      if (trade.closeReason === "tp" && trade.rrPreset) {
        byRRPresetCounts.set(trade.rrPreset, (byRRPresetCounts.get(trade.rrPreset) ?? 0) + 1);
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

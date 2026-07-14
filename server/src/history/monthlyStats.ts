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
  /** % к депозиту за месяц. Null, если на начало месяца не было снимка эквити (см. db/repositories/equitySnapshots.ts). */
  resultPct: number | null;
  tradingDays: number;
  daysWithoutTrading: number;
  daysInMonth: number;
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

/** Возвращает базу эквити (снимок на начало месяца) для расчёта resultPct. Null — данных нет, месяц был до появления снимков. */
export type EquityBaselineLookup = (year: number, month: number) => number | null;

/**
 * Месячная статистика для вкладки "Статистика" в Истории (docs/PROJECT.md). Группируем
 * по месяцу ЗАКРЫТИЯ сделки (closedAt) — результат месяца формируется в момент, когда
 * сделка фактически завершилась. "Торговые дни" внутри месяца считаем по тому же
 * closedAt, чтобы не было утечки дней за границы месяца при позициях, держащихся через
 * полночь 31/1 числа.
 */
export function computeMonthlyStats(
  trades: MonthlyStatTradeInput[],
  tzOffsetMinutes: number,
  getEquityBaseline: EquityBaselineLookup,
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
    let sumUsd = 0;
    const byRRPresetCounts = new Map<string, number>();

    for (const trade of monthTrades) {
      const resultR = trade.resultR!;
      sumR += resultR;
      if (trade.riskUsd !== null) {
        sumUsd += resultR * trade.riskUsd;
      }
      if (resultR > 0) winCount += 1;

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

    const equityBaseline = getEquityBaseline(year, month);
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
      resultPct,
      tradingDays: tradingDays.size,
      daysWithoutTrading: Math.max(daysElapsed - tradingDays.size, 0),
      daysInMonth: totalDaysInMonth,
      byRRPreset: RR_PRESETS.filter((preset) => byRRPresetCounts.has(preset)).map((preset) => ({
        preset,
        count: byRRPresetCounts.get(preset)!,
      })),
    });
  }

  result.sort((a, b) => (b.year !== a.year ? b.year - a.year : b.month - a.month));
  return result;
}

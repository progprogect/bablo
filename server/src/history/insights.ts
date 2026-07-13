import { getLocalHour } from "../risk/tradingDay.js";

export type PeriodKey = "night" | "morning" | "day" | "evening";

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  night: "Ночь (00:00–06:00)",
  morning: "Утро (06:00–12:00)",
  day: "День (12:00–18:00)",
  evening: "Вечер (18:00–24:00)",
};

const PERIOD_ORDER: PeriodKey[] = ["night", "morning", "day", "evening"];

export type PeriodStats = {
  key: PeriodKey;
  totalTrades: number;
  profitableTrades: number;
  winRate: number;
};

export type TimeOfDayStats = {
  periods: PeriodStats[];
  /** Период с наибольшим числом прибыльных сделок; null, если прибыльных сделок нет вообще. */
  bestPeriod: PeriodKey | null;
};

function periodForHour(hour: number): PeriodKey {
  if (hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "day";
  return "evening";
}

/**
 * Инсайт «в какое время дня чаще открывались прибыльные сделки» (см. docs/PROJECT.md).
 * Группируем по времени ОТКРЫТИЯ (openedAt) — решение входить в сделку принимается
 * в этот момент, а не в момент закрытия. Сутки делим на 4 крупных периода — часовые
 * бины дали бы разреженную, малоинформативную статистику при небольшом числе сделок.
 */
export function computeTimeOfDayStats(
  trades: { openedAt: Date; resultR: number | null }[],
  tzOffsetMinutes: number,
): TimeOfDayStats {
  const buckets: Record<PeriodKey, { total: number; profitable: number }> = {
    night: { total: 0, profitable: 0 },
    morning: { total: 0, profitable: 0 },
    day: { total: 0, profitable: 0 },
    evening: { total: 0, profitable: 0 },
  };

  for (const trade of trades) {
    if (trade.resultR === null) continue;
    const period = periodForHour(getLocalHour(trade.openedAt, tzOffsetMinutes));
    buckets[period].total += 1;
    if (trade.resultR > 0) {
      buckets[period].profitable += 1;
    }
  }

  const periods: PeriodStats[] = PERIOD_ORDER.map((key) => ({
    key,
    totalTrades: buckets[key].total,
    profitableTrades: buckets[key].profitable,
    winRate: buckets[key].total > 0 ? buckets[key].profitable / buckets[key].total : 0,
  }));

  const bestPeriod = periods.reduce<PeriodStats | null>((best, current) => {
    if (current.profitableTrades === 0) return best;
    if (!best || current.profitableTrades > best.profitableTrades) return current;
    return best;
  }, null);

  return { periods, bestPeriod: bestPeriod?.key ?? null };
}

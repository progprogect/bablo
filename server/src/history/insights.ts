import { getLocalDateKey, getLocalHour, getLocalMinuteOfDay } from "../risk/tradingDay.js";
import { RR_PRESETS } from "../trades/math.js";

export type InsightTradeInput = {
  symbol: string;
  openedAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
  resultR: number | null;
  riskUsd: number | null;
  rrPreset: string | null;
};

export type PresetOutcome = {
  preset: string;
  totalTrades: number;
  tpCount: number;
  /** tpCount / totalTrades — как часто цена доходит до этого пресета. */
  hitRate: number;
  /** Сколько из НЕ дошедших до тейка сделок с этим пресетом закрылись по стопу. */
  slCount: number;
  /** Средний resultR именно среди этих закрытых по стопу сделок (не среди всех) — конкретно "цена" промаха, без смешивания с прибыльными исходами. 0, если slCount = 0. */
  avgSlResultR: number;
};

export type HourBucketStat = { hour: number; total: number; tpCount: number };

export type TradeInsights = {
  /**
   * Часы открытия, в которые не меньше половины открытых сделок закрылись по тейку
   * (hitRate ≥ 50% — именно это и означает "прибыльный час", а не resultR > 0 у отдельной
   * сделки). Топ-3 по числу сделок, закрытых по тейку.
   */
  topProfitableHours: { hour: number; tpCount: number; total: number }[];
  /** Часы открытия, после которых сделка чаще всего закрывалась по стопу (топ-2, только ненулевые). */
  topStopHours: { hour: number; count: number }[];
  /**
   * % прибыльности по каждому активу с хотя бы одной закрытой сделкой:
   * доля closeReason === "tp" среди всех сделок актива. Сортировка: hitRate ↓, затем total ↓.
   */
  assetOutcomes: { symbol: string; tpCount: number; totalTrades: number }[];
  /** Активы с наибольшим числом закрытий по стопу (топ-2, только ненулевые). */
  topStopAssets: { symbol: string; count: number }[];
  /** Типичный (медианный) час, к которому в удачные дни достигается дневная цель +targetR. Null, если цель ни разу не была достигнута. */
  dailyTargetHour: { targetR: number; hour: number } | null;
  /**
   * Диапазон времени «отработки» пресета R/R 1/3: от открытия до закрытия по тейку.
   * min/max по часам среди сделок с rrPreset === "1/3" и closeReason === "tp".
   * Нужен, чтобы не сидеть в графике — понимать, сколько обычно ждёт 1/3.
   */
  rrHoldDuration: { preset: string; minHours: number; maxHours: number; sampleCount: number } | null;
  /** Статистика по пресетам R/R (1/1, 1/2…) среди сделок, у которых пресет был задан — см. presetOutcomes(). */
  presetOutcomes: PresetOutcome[];
};

const HOURS_IN_DAY = 24;

function emptyHourBuckets(): HourBucketStat[] {
  return Array.from({ length: HOURS_IN_DAY }, (_, hour) => ({ hour, total: 0, tpCount: 0 }));
}

function bucketByOpenHour(
  trades: InsightTradeInput[],
  tzOffsetMinutes: number,
): { buckets: HourBucketStat[]; slCountsByHour: number[] } {
  const buckets = emptyHourBuckets();
  const slCountsByHour = Array.from({ length: HOURS_IN_DAY }, () => 0);

  for (const trade of trades) {
    if (trade.resultR === null) continue;
    const hour = getLocalHour(trade.openedAt, tzOffsetMinutes);
    const bucket = buckets[hour]!;
    bucket.total += 1;
    if (trade.closeReason === "tp") {
      bucket.tpCount += 1;
    }
    if (trade.closeReason === "sl") {
      slCountsByHour[hour] = (slCountsByHour[hour] ?? 0) + 1;
    }
  }

  return { buckets, slCountsByHour };
}

/** "Прибыльный час" — не меньше половины сделок, открытых в этот час, дошли до тейка. */
function topProfitableHours(buckets: HourBucketStat[], limit: number): TradeInsights["topProfitableHours"] {
  return buckets
    .filter((bucket) => bucket.total > 0 && bucket.tpCount / bucket.total >= 0.5)
    .sort((a, b) => b.tpCount - a.tpCount)
    .slice(0, limit)
    .map((bucket) => ({ hour: bucket.hour, tpCount: bucket.tpCount, total: bucket.total }));
}

function topStopHours(slCountsByHour: number[], limit: number): TradeInsights["topStopHours"] {
  return slCountsByHour
    .map((count, hour) => ({ hour, count }))
    .filter((bucket) => bucket.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** % прибыльности по каждому активу: tpCount/total среди сделок с известным resultR. */
function assetOutcomes(trades: InsightTradeInput[]): TradeInsights["assetOutcomes"] {
  const bySymbol = new Map<string, { tpCount: number; totalTrades: number }>();

  for (const trade of trades) {
    if (trade.resultR === null) continue;
    const entry = bySymbol.get(trade.symbol) ?? { tpCount: 0, totalTrades: 0 };
    entry.totalTrades += 1;
    if (trade.closeReason === "tp") {
      entry.tpCount += 1;
    }
    bySymbol.set(trade.symbol, entry);
  }

  return [...bySymbol.entries()]
    .map(([symbol, stats]) => ({ symbol, tpCount: stats.tpCount, totalTrades: stats.totalTrades }))
    .sort((a, b) => {
      const hitA = a.tpCount / a.totalTrades;
      const hitB = b.tpCount / b.totalTrades;
      if (hitB !== hitA) return hitB - hitA;
      if (b.totalTrades !== a.totalTrades) return b.totalTrades - a.totalTrades;
      return a.symbol.localeCompare(b.symbol);
    });
}

/** Активы с наибольшим числом стопов — зеркало topStopHours для символов. */
function topStopAssets(trades: InsightTradeInput[], limit: number): TradeInsights["topStopAssets"] {
  const slBySymbol = new Map<string, number>();

  for (const trade of trades) {
    if (trade.resultR === null || trade.closeReason !== "sl") continue;
    slBySymbol.set(trade.symbol, (slBySymbol.get(trade.symbol) ?? 0) + 1);
  }

  return [...slBySymbol.entries()]
    .map(([symbol, count]) => ({ symbol, count }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol))
    .slice(0, limit);
}

/**
 * Статистика "сколько сделок закрылось по тейку" в разрезе пресетов R/R (docs/PROJECT.md).
 * hitRate — доля сделок с этим пресетом, где цена реально дошла до тейка (обратная величина
 * отвечает на "как часто цена не доходит до, например, 1/2"). Для промахов отдельно считаем
 * долю закрытых по стопу и их средний R — конкретную "цену" промаха, а не смешанное среднее
 * по всем исходам (которое на малой выборке выглядит как случайное "-1R" без контекста).
 */
function presetOutcomes(trades: InsightTradeInput[]): PresetOutcome[] {
  const byPreset = new Map<string, { total: number; tp: number; sl: number; slSumR: number }>();

  for (const trade of trades) {
    if (trade.resultR === null || !trade.rrPreset) continue;
    const entry = byPreset.get(trade.rrPreset) ?? { total: 0, tp: 0, sl: 0, slSumR: 0 };
    entry.total += 1;
    if (trade.closeReason === "tp") {
      entry.tp += 1;
    } else if (trade.closeReason === "sl") {
      entry.sl += 1;
      entry.slSumR += trade.resultR;
    }
    byPreset.set(trade.rrPreset, entry);
  }

  return RR_PRESETS.filter((preset) => byPreset.has(preset)).map((preset) => {
    const stats = byPreset.get(preset)!;
    return {
      preset,
      totalTrades: stats.total,
      tpCount: stats.tp,
      hitRate: stats.total > 0 ? stats.tp / stats.total : 0,
      slCount: stats.sl,
      avgSlResultR: stats.sl > 0 ? stats.slSumR / stats.sl : 0,
    };
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Типичный час достижения дневной цели +targetR (например, +3R дневного лимита прибыли,
 * см. docs/RISK_ENGINE.md). Для каждого календарного дня идём по закрытым сделкам в
 * хронологическом порядке и находим момент, когда накопленный R впервые достигает цели —
 * это и есть "момент достижения" для этого дня. Из всех таких моментов берём медианный
 * час (устойчивее к выбросам, чем среднее) и округляем вверх до полного часа — так
 * результат читается как "обычно закрываю цель К такому-то часу".
 */
function dailyTargetHour(
  trades: InsightTradeInput[],
  targetR: number,
  tzOffsetMinutes: number,
): TradeInsights["dailyTargetHour"] {
  if (!(targetR > 0)) return null;

  const byDay = new Map<string, InsightTradeInput[]>();
  for (const trade of trades) {
    if (trade.resultR === null || !trade.closedAt) continue;
    const dayKey = getLocalDateKey(trade.closedAt, tzOffsetMinutes);
    const list = byDay.get(dayKey);
    if (list) {
      list.push(trade);
    } else {
      byDay.set(dayKey, [trade]);
    }
  }

  const crossingMinutes: number[] = [];
  for (const dayTrades of byDay.values()) {
    const sorted = [...dayTrades].sort((a, b) => a.closedAt!.getTime() - b.closedAt!.getTime());
    let cumulativeR = 0;
    for (const trade of sorted) {
      cumulativeR += trade.resultR!;
      if (cumulativeR >= targetR) {
        crossingMinutes.push(getLocalMinuteOfDay(trade.closedAt!, tzOffsetMinutes));
        break;
      }
    }
  }

  if (crossingMinutes.length === 0) return null;
  const hour = Math.ceil(median(crossingMinutes) / 60) % HOURS_IN_DAY;
  return { targetR, hour };
}

/** Пресет, для которого показываем типичное время «дожития» до тейка в подсказке. */
export const HOLD_DURATION_PRESET = "1/3";

/**
 * Округление длительности до целых часов (≥ 1), чтобы в подсказке было «2ч - 7ч»,
 * а не минуты — достаточно для спокойствия «сделка может идти часами».
 */
export function durationMsToHours(ms: number): number {
  if (!(ms > 0) || !Number.isFinite(ms)) return 1;
  return Math.max(1, Math.round(ms / 3_600_000));
}

/**
 * Диапазон времени отработки R/R 1/3: только сделки, реально дошедшие до тейка с этим
 * пресетом. SL/manual/external не считаем — это не «отработка» плана 1/3.
 * Нужно ≥ 1 такой сделки; при одной — min === max.
 */
function rrHoldDuration(trades: InsightTradeInput[]): TradeInsights["rrHoldDuration"] {
  const durationsMs: number[] = [];

  for (const trade of trades) {
    if (trade.rrPreset !== HOLD_DURATION_PRESET) continue;
    if (trade.closeReason !== "tp") continue;
    if (!trade.closedAt) continue;
    const ms = trade.closedAt.getTime() - trade.openedAt.getTime();
    if (!(ms > 0)) continue;
    durationsMs.push(ms);
  }

  if (durationsMs.length === 0) return null;

  const hours = durationsMs.map(durationMsToHours);
  return {
    preset: HOLD_DURATION_PRESET,
    minHours: Math.min(...hours),
    maxHours: Math.max(...hours),
    sampleCount: hours.length,
  };
}

/**
 * Инсайты по истории сделок для карточки-подсказки на экране "Сделки" (docs/PROJECT.md).
 * Все метрики считаются по времени ОТКРЫТИЯ (решение войти принимается в этот момент),
 * кроме "дневной цели", которая по смыслу привязана к моменту ЗАКРЫТИЯ — именно закрытые
 * сделки формируют дневной результат.
 */
export function computeTradeInsights(
  trades: InsightTradeInput[],
  tzOffsetMinutes: number,
  dailyProfitLimitR: number,
): TradeInsights {
  const { buckets, slCountsByHour } = bucketByOpenHour(trades, tzOffsetMinutes);
  return {
    topProfitableHours: topProfitableHours(buckets, 3),
    topStopHours: topStopHours(slCountsByHour, 2),
    assetOutcomes: assetOutcomes(trades),
    topStopAssets: topStopAssets(trades, 2),
    dailyTargetHour: dailyTargetHour(trades, dailyProfitLimitR, tzOffsetMinutes),
    rrHoldDuration: rrHoldDuration(trades),
    presetOutcomes: presetOutcomes(trades),
  };
}

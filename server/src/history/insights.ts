import { getLocalDateKey, getLocalHour, getLocalMinuteOfDay } from "../risk/tradingDay.js";
import { RR_PRESETS } from "../trades/math.js";
import {
  resolveStatsResultR,
  resolveTradeOutcome,
  roundStatsR,
  type TradeOutcome,
} from "./outcome.js";

export type InsightTradeInput = {
  symbol: string;
  openedAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
  resultR: number | null;
  riskUsd: number | null;
  rrPreset: string | null;
  /** Нужны, чтобы отличить реальный стоп от стопа, уведённого в прибыль (history/outcome.ts). */
  entryPrice: number | null;
  slPrice: number | null;
  side: string;
  /** Ручной оверрайд исхода из админки (тейк/стоп/БУ) — см. history/outcome.ts. */
  statsOutcome?: string | null;
  /** Ручной столбец R из админки — он же задаёт R сделки для инсайтов (resolveStatsResultR). */
  statsRrPreset?: string | null;
};

/**
 * Исход сделки для инсайтов «прибыльно/убыточно»: стоп, уведённый в прибыль (ночное
 * правило 1/1, правило после partial), считается тейком — сделка закончилась в плюс
 * по нашему же решению.
 *
 * ВАЖНО: этим меряется результат, а не отработка плана. Там, где вопрос именно «дошла ли
 * цена до заданного R/R» (presetOutcomes, rrHoldDuration), по-прежнему нужен строгий
 * closeReason === "tp": зафиксированный на 1/1 стоп до пресета 1/3 не дошёл.
 */
function outcomeOf(trade: InsightTradeInput): TradeOutcome {
  return resolveTradeOutcome(trade, trade.resultR ?? 0);
}

/**
 * R сделки для инсайтов: с учётом ручного столбца R из админки. Нужен там, где
 * величина R имеет смысл — накопление дневной цели и «цена промаха» по пресету.
 */
function statsResultROf(trade: InsightTradeInput): number | null {
  const value = resolveStatsResultR(trade, outcomeOf(trade));
  if (value !== null) return value;
  return trade.resultR === null ? null : roundStatsR(trade.resultR);
}

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
   * Разбивка по часам ОТКРЫТИЯ: для каждого часа с хотя бы одной закрытой сделкой —
   * сколько всего сделок открыто в этот час и сколько из них дошло до тейка (по исходу,
   * см. outcomeOf). Отсортировано по номеру часа ↑; UI (InsightPanel) сам раскладывает
   * в порядок торгового дня (7ч…6ч) и добивает пустые часы без данных.
   *
   * Решение от 30.08.2026: раньше сервер отдавал только «прибыльные» (≥50% тейков) и
   * «убыточные» (>50% стопов) часы, отсортированные по силе — пользователь попросил
   * видеть ВСЕ часы подряд с долей тейков, а сильные отмечать галочкой на клиенте.
   */
  hourlyOutcomes: { hour: number; tpCount: number; total: number }[];
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

function bucketByOpenHour(trades: InsightTradeInput[], tzOffsetMinutes: number): HourBucketStat[] {
  const buckets = emptyHourBuckets();

  for (const trade of trades) {
    if (trade.resultR === null) continue;
    const hour = getLocalHour(trade.openedAt, tzOffsetMinutes);
    const bucket = buckets[hour]!;
    bucket.total += 1;
    if (outcomeOf(trade) === "tp") {
      bucket.tpCount += 1;
    }
  }

  return buckets;
}

/**
 * Все часы, в которые открывалась хотя бы одна закрытая сделка, по номеру часа ↑.
 * Пустые часы не шлём — их 24 штуки каждый раз, клиент дорисует их сам (см. TradeInsights).
 */
function hourlyOutcomes(buckets: HourBucketStat[]): TradeInsights["hourlyOutcomes"] {
  return buckets
    .filter((bucket) => bucket.total > 0)
    .map((bucket) => ({ hour: bucket.hour, tpCount: bucket.tpCount, total: bucket.total }));
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
    } else if (trade.closeReason === "sl" && outcomeOf(trade) === "sl") {
      // Только реальный стоп: закрытие по стопу, уведённому в прибыль, до пресета не
      // дошло (значит не tp), но и «ценой промаха» не является — иначе средний R
      // промаха оказался бы положительным.
      entry.sl += 1;
      entry.slSumR += statsResultROf(trade) ?? trade.resultR;
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
      cumulativeR += statsResultROf(trade) ?? trade.resultR!;
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
  const buckets = bucketByOpenHour(trades, tzOffsetMinutes);
  return {
    hourlyOutcomes: hourlyOutcomes(buckets),
    dailyTargetHour: dailyTargetHour(trades, dailyProfitLimitR, tzOffsetMinutes),
    rrHoldDuration: rrHoldDuration(trades),
    presetOutcomes: presetOutcomes(trades),
  };
}

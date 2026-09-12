import { getLocalHour } from "../risk/tradingDay.js";
import { resolveTradeOutcome, type TradeOutcome } from "./outcome.js";

export type InsightTradeInput = {
  openedAt: Date;
  closeReason: string | null;
  resultR: number | null;
  /** Нужны, чтобы отличить реальный стоп от стопа, уведённого в прибыль (history/outcome.ts). */
  entryPrice: number | null;
  slPrice: number | null;
  side: string;
  /** Ручной оверрайд исхода из админки (тейк/стоп/БУ) — см. history/outcome.ts. */
  statsOutcome?: string | null;
};

/**
 * Исход сделки для инсайтов «прибыльно/убыточно»: стоп, уведённый в прибыль (ночное
 * правило 1/1, трейлинг-лестница, правило после partial), считается тейком — сделка
 * закончилась в плюс по нашему же решению.
 */
function outcomeOf(trade: InsightTradeInput): TradeOutcome {
  return resolveTradeOutcome(trade, trade.resultR ?? 0);
}

export type HourBucketStat = { hour: number; total: number; tpCount: number };

export type TradeInsights = {
  /**
   * Разбивка по часам ОТКРЫТИЯ: для каждого часа с хотя бы одной закрытой сделкой —
   * сколько всего сделок открыто в этот час и сколько из них дошло до тейка (по исходу,
   * см. outcomeOf). Отсортировано по номеру часа ↑; UI (InsightPanel) сам раскладывает
   * в порядок торгового дня (7ч…6ч) и добивает пустые часы без данных.
   *
   * Единственная метрика подсказки: 11.09.2026 из неё убраны статистика по пресетам R/R,
   * типичный час дневной цели и «время отработки 1/3» — вместе с их расчётами здесь.
   */
  hourlyOutcomes: { hour: number; tpCount: number; total: number }[];
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
 * Строка закрытой сделки из БД (numeric-колонки drizzle отдаёт строками) — ровно те поля,
 * из которых считаются часы.
 */
export type ClosedTradeRowForInsights = {
  openedAt: Date;
  closeReason: string | null;
  resultR: string | null;
  entryPrice: string | null;
  slPrice: string | null;
  side: string;
  statsOutcome: string | null;
};

/**
 * Приведение строки БД ко входу инсайтов. Общее для подсказки (api/stats.ts) и правила
 * убыточных часов (risk/hourBlocksService.ts) — один разбор numeric, одна трактовка.
 */
export function toInsightInput(row: ClosedTradeRowForInsights): InsightTradeInput {
  return {
    openedAt: row.openedAt,
    closeReason: row.closeReason,
    resultR: row.resultR !== null ? Number(row.resultR) : null,
    entryPrice: row.entryPrice !== null ? Number(row.entryPrice) : null,
    slPrice: row.slPrice !== null ? Number(row.slPrice) : null,
    side: row.side,
    statsOutcome: row.statsOutcome,
  };
}

/**
 * Инсайты по истории сделок для карточки-подсказки на экране "Сделки" (docs/PROJECT.md).
 * Считаются по времени ОТКРЫТИЯ — решение войти принимается именно в этот момент.
 */
export function computeTradeInsights(
  trades: InsightTradeInput[],
  tzOffsetMinutes: number,
): TradeInsights {
  return { hourlyOutcomes: hourlyOutcomes(bucketByOpenHour(trades, tzOffsetMinutes)) };
}

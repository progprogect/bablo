import { getKlines } from "../bingx/client.js";
import { getTradeById, type Trade } from "../db/repositories/trades.js";
import {
  computeExcursions,
  lastClosedIndex,
  METRICS_VERSION,
  snapshotAt,
  type Candle,
  type IndicatorSnapshot,
  type TradeExcursions,
} from "./indicators.js";
import { entryRiskDistance } from "./logic.js";
import {
  getCandleSync,
  insertCandles,
  listCandles,
  listTradeIdsMissingSync,
  upsertCandleSync,
  upsertTradeMetrics,
} from "./marketRepository.js";

/**
 * Сбор рыночных данных для журнала: свечи BingX вокруг сделки → кэш в БД (навсегда:
 * закрытая сделка «замораживает» свой период) + снапшот индикаторов и производных
 * (journal_trade_metrics, в UI не выводится). Источник — ПУБЛИЧНЫЙ market-data эндпоинт
 * klines, ключи BingX не нужны. Все запросы событийные: закрытие сделки, бэкфилл на
 * старте, ленивый добор при открытии графика — циклического опроса нет.
 */

export type CandleIntervalKey = "15m" | "1h";

export type CandleIntervalConfig = {
  key: CandleIntervalKey;
  stepMs: number;
  /** Сколько истории ДО входа: контекст для глаза и прогрев индикаторов (EMA200 и т.п.). */
  beforeMs: number;
  /** Сколько после закрытия — видно, что было дальше. */
  afterMs: number;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const JOURNAL_CANDLE_INTERVALS: CandleIntervalConfig[] = [
  { key: "15m", stepMs: 15 * 60_000, beforeMs: 3 * DAY, afterMs: 1 * DAY },
  { key: "1h", stepMs: HOUR, beforeMs: 12 * DAY, afterMs: 3 * DAY },
];

export function intervalConfig(key: string): CandleIntervalConfig | null {
  return JOURNAL_CANDLE_INTERVALS.find((config) => config.key === key) ?? null;
}

/** Окно свечей сделки: [вход − before; min(закрытие + after, сейчас)]. */
export function tradeCandleWindow(trade: Trade, config: CandleIntervalConfig): { fromMs: number; toMs: number } {
  const openedMs = trade.openedAt.getTime();
  const closedMs = trade.closedAt ? trade.closedAt.getTime() : openedMs;
  return {
    fromMs: openedMs - config.beforeMs,
    toMs: Math.min(closedMs + config.afterMs, Date.now()),
  };
}

/**
 * Гарантирует, что окно свечей сделки собрано (идемпотентно: факт сбора — строка в
 * journal_candle_syncs). Пагинация по limit BingX (1440), вставка — ON CONFLICT DO NOTHING.
 * Возвращает число свечей, полученных от биржи при этом вызове (0 при уже собранном окне).
 */
export async function ensureTradeCandles(trade: Trade, config: CandleIntervalConfig): Promise<number> {
  const existing = await getCandleSync(trade.id, config.key);
  if (existing) return 0;

  const { fromMs, toMs } = tradeCandleWindow(trade, config);
  let cursor = fromMs;
  let fetched = 0;
  // Страховка от зацикливания при неожиданном ответе биржи: окно/шаг + запас.
  const maxPages = Math.ceil((toMs - fromMs) / config.stepMs / 1000) + 3;
  for (let page = 0; page < maxPages && cursor < toMs; page += 1) {
    const batch = await getKlines(trade.symbol, config.key, cursor, toMs, 1440);
    if (batch.length === 0) break;
    await insertCandles(trade.symbol, config.key, batch);
    fetched += batch.length;
    const lastTime = batch[batch.length - 1]!.time;
    if (lastTime + config.stepMs <= cursor) break; // биржа не продвинулась — выходим
    cursor = lastTime + config.stepMs;
    if (batch.length < 1440) break;
  }
  await upsertCandleSync(trade.id, config.key, fromMs, toMs, fetched);
  return fetched;
}

// --- Метрики -------------------------------------------------------------------------------

export type TradeMetricsPayload = {
  version: number;
  /** Снапшот индикаторов по последней ЗАКРЫТОЙ свече до входа, по таймфреймам. */
  atEntry: Partial<Record<CandleIntervalKey, IndicatorSnapshot | null>>;
  /** MAE/MFE по 15m-свечам за время сделки. */
  excursions: TradeExcursions;
};

/** Чистая сборка payload метрик — отделена от I/O ради тестируемости. */
export function buildTradeMetrics(
  trade: Pick<Trade, "side" | "openedAt" | "closedAt"> & {
    entryPriceNum: number | null;
    riskDistance: number | null;
  },
  candlesByInterval: Partial<Record<CandleIntervalKey, Candle[]>>,
): TradeMetricsPayload {
  const openedMs = trade.openedAt.getTime();
  const closedMs = trade.closedAt ? trade.closedAt.getTime() : openedMs;
  const atEntry: TradeMetricsPayload["atEntry"] = {};

  for (const config of JOURNAL_CANDLE_INTERVALS) {
    const candles = candlesByInterval[config.key] ?? [];
    const index = lastClosedIndex(candles, openedMs, config.stepMs);
    atEntry[config.key] = index === null ? null : snapshotAt(candles, index);
  }

  const candles15m = candlesByInterval["15m"] ?? [];
  const excursions =
    trade.entryPriceNum !== null && trade.riskDistance !== null
      ? computeExcursions(
          candles15m,
          trade.side as "long" | "short",
          trade.entryPriceNum,
          trade.riskDistance,
          openedMs,
          closedMs,
          15 * 60_000,
        )
      : { maeR: null, mfeRFromCandles: null };

  return { version: METRICS_VERSION, atEntry, excursions };
}

/**
 * Полный сбор данных сделки: свечи обоих таймфреймов + снапшот метрик. Идемпотентно.
 * Вызывается fire-and-forget из закрытия сделки, бэкфилла и лениво из GET графика —
 * ошибки здесь никогда не роняют вызывающий путь.
 */
export async function collectTradeMarketData(tradeId: number): Promise<void> {
  const trade = await getTradeById(tradeId);
  if (!trade || trade.status !== "closed") return;

  const candlesByInterval: Partial<Record<CandleIntervalKey, Candle[]>> = {};
  for (const config of JOURNAL_CANDLE_INTERVALS) {
    await ensureTradeCandles(trade, config);
    const { fromMs, toMs } = tradeCandleWindow(trade, config);
    candlesByInterval[config.key] = await listCandles(trade.symbol, config.key, fromMs, toMs);
  }

  const entryPriceNum = trade.entryPrice !== null ? Number(trade.entryPrice) : null;
  const payload = buildTradeMetrics(
    {
      side: trade.side,
      openedAt: trade.openedAt,
      closedAt: trade.closedAt,
      entryPriceNum,
      riskDistance: entryRiskDistance({
        side: trade.side as "long" | "short",
        entryPrice: entryPriceNum,
        slPrice: trade.slPrice !== null ? Number(trade.slPrice) : null,
        quantity: Number(trade.quantity),
        riskUsd: trade.riskUsd !== null ? Number(trade.riskUsd) : null,
      }),
    },
    candlesByInterval,
  );
  await upsertTradeMetrics(trade.id, METRICS_VERSION, payload);
}

const BACKFILL_PAUSE_MS = 300;

/**
 * Разовый бэкфилл после старта сервера: собрать данные для закрытых сделок, у которых
 * окна свечей ещё нет. Последовательно и с паузой — щадяще к rate-limit'ам BingX;
 * fire-and-forget: сервер уже слушает, сбой одной сделки не мешает остальным.
 * Для старых сделок биржа может уже не хранить мелкие таймфреймы — тогда окно честно
 * фиксируется с candles_fetched = 0 и повторно не запрашивается.
 */
export async function backfillJournalMarketData(log: {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}): Promise<void> {
  const tradeIds = await listTradeIdsMissingSync(JOURNAL_CANDLE_INTERVALS.map((config) => config.key));
  if (tradeIds.length === 0) return;
  log.info({ trades: tradeIds.length }, "Журнал: бэкфилл свечей и метрик начат");
  let done = 0;
  let failed = 0;
  for (const tradeId of tradeIds) {
    try {
      await collectTradeMarketData(tradeId);
      done += 1;
    } catch (error) {
      failed += 1;
      log.error({ error, tradeId }, "Журнал: не удалось собрать данные сделки");
    }
    await new Promise((resolve) => setTimeout(resolve, BACKFILL_PAUSE_MS));
  }
  log.info({ done, failed }, "Журнал: бэкфилл свечей и метрик завершён");
}

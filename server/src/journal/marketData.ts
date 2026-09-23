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
import { structureSnapshotAtEntry, type StructureSnapshot } from "./structure.js";
import {
  getCandleSync,
  insertCandles,
  listCandles,
  listTradeIdsMissingSync,
  listTradeIdsNeedingMetrics,
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

/**
 * Догрузка истории влево (pull-to-load на графике, 23.09.2026): за раз окно расширяется
 * ещё на beforeMs интервала, но не глубже потолка от входа сделки — защита от
 * бесконечного дотягивания в мегазапросы.
 */
export const EXTEND_MAX_DEPTH_MS: Record<CandleIntervalKey, number> = {
  "15m": 45 * DAY,
  "1h": 365 * DAY,
};

/** Новое начало окна после догрузки: ещё beforeMs влево, но не глубже потолка. null — уже упёрлись. */
export function computeExtendedFromMs(
  currentFromMs: number,
  tradeOpenedMs: number,
  config: CandleIntervalConfig,
): number | null {
  const floor = tradeOpenedMs - EXTEND_MAX_DEPTH_MS[config.key];
  const next = Math.max(currentFromMs - config.beforeMs, floor);
  return next < currentFromMs ? next : null;
}

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

export type ExtendResult = { added: number; exhausted: boolean };

/**
 * Расширяет окно свечей сделки в прошлое на один шаг (см. computeExtendedFromMs).
 * Новые свечи ложатся в тот же вечный кэш; факт — обновлённый from_time в
 * journal_candle_syncs. exhausted: упёрлись в потолок глубины ИЛИ биржа не отдала
 * ни одной свечи (история кончилась) — клиенту больше не предлагать тянуть.
 */
export async function extendTradeCandlesBack(trade: Trade, config: CandleIntervalConfig): Promise<ExtendResult> {
  // Без собранного базового окна расширять нечего — соберём его.
  await ensureTradeCandles(trade, config);
  const sync = await getCandleSync(trade.id, config.key);
  if (!sync) return { added: 0, exhausted: false };

  const currentFromMs = sync.fromTime.getTime();
  const newFromMs = computeExtendedFromMs(currentFromMs, trade.openedAt.getTime(), config);
  if (newFromMs === null) return { added: 0, exhausted: true };

  let cursor = newFromMs;
  let added = 0;
  const maxPages = Math.ceil((currentFromMs - newFromMs) / config.stepMs / 1000) + 3;
  for (let page = 0; page < maxPages && cursor < currentFromMs; page += 1) {
    const batch = await getKlines(trade.symbol, config.key, cursor, currentFromMs, 1440);
    if (batch.length === 0) break;
    await insertCandles(trade.symbol, config.key, batch);
    added += batch.length;
    const lastTime = batch[batch.length - 1]!.time;
    if (lastTime + config.stepMs <= cursor) break;
    cursor = lastTime + config.stepMs;
    if (batch.length < 1440) break;
  }

  await upsertCandleSync(trade.id, config.key, newFromMs, sync.toTime.getTime(), sync.candlesFetched + added);
  return { added, exhausted: added === 0 };
}

// --- Метрики -------------------------------------------------------------------------------

export type TradeMetricsPayload = {
  version: number;
  /** Снапшот индикаторов по последней ЗАКРЫТОЙ свече до входа, по таймфреймам. */
  atEntry: Partial<Record<CandleIntervalKey, IndicatorSnapshot | null>>;
  /** MAE/MFE по 15m-свечам за время сделки. */
  excursions: TradeExcursions;
  /** Структура цены на входе (по 15m): уровни, последний BOS до входа, вход в зоне. */
  structure: StructureSnapshot | null;
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

  const structure =
    candles15m.length > 0
      ? structureSnapshotAtEntry(candles15m, 15 * 60_000, openedMs, trade.entryPriceNum)
      : null;

  return { version: METRICS_VERSION, atEntry, excursions, structure };
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
  // Две причины пересборки: не собраны свечи ИЛИ метрики посчитаны старой версией формул
  // (METRICS_VERSION вырос) — свечи у таких уже есть, пересчёт не ходит к бирже.
  const missingSync = await listTradeIdsMissingSync(JOURNAL_CANDLE_INTERVALS.map((config) => config.key));
  const staleMetrics = await listTradeIdsNeedingMetrics(METRICS_VERSION);
  const tradeIds = [...new Set([...missingSync, ...staleMetrics])];
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

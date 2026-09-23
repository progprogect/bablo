import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import type { Candle } from "./indicators.js";
import {
  journalCandles,
  journalCandleSyncs,
  journalChartDrawings,
  journalTradeMetrics,
} from "./schema.js";

// --- Свечи ---------------------------------------------------------------------------------

/** Идемпотентная запись пачки свечей: (symbol, interval, open_time) уникальны. */
export async function insertCandles(symbol: string, interval: string, candles: Candle[]): Promise<void> {
  if (candles.length === 0) return;
  const db = getDb();
  await db
    .insert(journalCandles)
    .values(
      candles.map((candle) => ({
        symbol,
        interval,
        openTime: new Date(candle.time),
        open: String(candle.open),
        high: String(candle.high),
        low: String(candle.low),
        close: String(candle.close),
        volume: String(candle.volume),
      })),
    )
    .onConflictDoNothing();
}

export async function listCandles(
  symbol: string,
  interval: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(journalCandles)
    .where(
      and(
        eq(journalCandles.symbol, symbol),
        eq(journalCandles.interval, interval),
        gte(journalCandles.openTime, new Date(fromMs)),
        lte(journalCandles.openTime, new Date(toMs)),
      ),
    )
    .orderBy(asc(journalCandles.openTime));
  return rows.map((row) => ({
    time: row.openTime.getTime(),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: row.volume !== null ? Number(row.volume) : 0,
  }));
}

// --- Факт сбора окна по сделке ---------------------------------------------------------------

export type CandleSync = typeof journalCandleSyncs.$inferSelect;

export async function getCandleSync(tradeId: number, interval: string): Promise<CandleSync | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(journalCandleSyncs)
    .where(and(eq(journalCandleSyncs.tradeId, tradeId), eq(journalCandleSyncs.interval, interval)))
    .limit(1);
  return row ?? null;
}

export async function upsertCandleSync(
  tradeId: number,
  interval: string,
  fromMs: number,
  toMs: number,
  candlesFetched: number,
): Promise<void> {
  const db = getDb();
  await db
    .insert(journalCandleSyncs)
    .values({
      tradeId,
      interval,
      fromTime: new Date(fromMs),
      toTime: new Date(toMs),
      candlesFetched,
    })
    .onConflictDoUpdate({
      target: [journalCandleSyncs.tradeId, journalCandleSyncs.interval],
      set: {
        fromTime: new Date(fromMs),
        toTime: new Date(toMs),
        candlesFetched,
        fetchedAt: new Date(),
      },
    });
}

/** id закрытых сделок, у которых ещё не собрано окно свечей хотя бы одного интервала. */
export async function listTradeIdsMissingSync(intervals: string[]): Promise<number[]> {
  const db = getDb();
  const rows = await db.execute<{ id: number }>(sql`
    SELECT t.id
    FROM trades t
    WHERE t.status = 'closed'
      AND (
        SELECT count(*) FROM journal_candle_syncs s
        WHERE s.trade_id = t.id AND s.interval = ANY(${intervals})
      ) < ${intervals.length}
    ORDER BY t.closed_at DESC
  `);
  return rows.map((row) => Number(row.id));
}

/** id закрытых сделок без метрик или с метриками устаревшей версии формул. */
export async function listTradeIdsNeedingMetrics(currentVersion: number): Promise<number[]> {
  const db = getDb();
  const rows = await db.execute<{ id: number }>(sql`
    SELECT t.id
    FROM trades t
    LEFT JOIN journal_trade_metrics m ON m.trade_id = t.id
    WHERE t.status = 'closed' AND (m.trade_id IS NULL OR m.version < ${currentVersion})
    ORDER BY t.closed_at DESC
  `);
  return rows.map((row) => Number(row.id));
}

// --- Метрики сделки --------------------------------------------------------------------------

export async function upsertTradeMetrics(tradeId: number, version: number, payload: unknown): Promise<void> {
  const db = getDb();
  await db
    .insert(journalTradeMetrics)
    .values({ tradeId, version, payload })
    .onConflictDoUpdate({
      target: journalTradeMetrics.tradeId,
      set: { version, payload, computedAt: new Date() },
    });
}

// --- Линии пользователя ----------------------------------------------------------------------

export type ChartDrawing = {
  id: string;
  t1: number;
  p1: number;
  t2: number;
  p2: number;
};

export async function getDrawings(tradeId: number): Promise<ChartDrawing[]> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(journalChartDrawings)
    .where(eq(journalChartDrawings.tradeId, tradeId))
    .limit(1);
  return (row?.drawings as ChartDrawing[] | undefined) ?? [];
}

export async function saveDrawings(tradeId: number, drawings: ChartDrawing[]): Promise<void> {
  const db = getDb();
  await db
    .insert(journalChartDrawings)
    .values({ tradeId, drawings })
    .onConflictDoUpdate({
      target: journalChartDrawings.tradeId,
      set: { drawings, updatedAt: new Date() },
    });
}

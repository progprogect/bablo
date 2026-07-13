import { and, count, desc, eq } from "drizzle-orm";
import { getDb } from "../client.js";
import { trades } from "../schema.js";
import type { TradeSide } from "../../trades/math.js";

export type Trade = typeof trades.$inferSelect;

export async function getActiveTrade(): Promise<Trade | null> {
  const db = getDb();
  const [row] = await db.select().from(trades).where(eq(trades.status, "active")).limit(1);
  return row ?? null;
}

export async function getTradeById(id: number): Promise<Trade | null> {
  const db = getDb();
  const [row] = await db.select().from(trades).where(eq(trades.id, id)).limit(1);
  return row ?? null;
}

export type CreateTradeInput = {
  symbol: string;
  side: TradeSide;
  quantity: number;
  leverage: number;
  entryPrice: number;
  slPrice: number;
  riskUsd: number;
  bingxOrderIds: Record<string, string | number>;
};

export async function createTrade(input: CreateTradeInput): Promise<Trade> {
  const db = getDb();
  const [created] = await db
    .insert(trades)
    .values({
      symbol: input.symbol,
      side: input.side,
      status: "active",
      quantity: String(input.quantity),
      leverage: input.leverage,
      entryPrice: String(input.entryPrice),
      slPrice: String(input.slPrice),
      riskUsd: String(input.riskUsd),
      bingxOrderIds: input.bingxOrderIds,
    })
    .returning();
  if (!created) {
    throw new Error("Не удалось создать сделку");
  }
  return created;
}

export type UpdateTradeInput = Partial<{
  tpPrice: number;
  rrPreset: string;
  bingxOrderIds: Record<string, string | number>;
  status: "active" | "closed";
  closedAt: Date;
  closeReason: string;
  closePrice: number;
  resultR: number;
  resultPct: number;
}>;

export async function updateTrade(id: number, input: UpdateTradeInput): Promise<Trade | null> {
  const db = getDb();
  const patch: Record<string, unknown> = {};
  if (input.tpPrice !== undefined) patch.tpPrice = String(input.tpPrice);
  if (input.rrPreset !== undefined) patch.rrPreset = input.rrPreset;
  if (input.bingxOrderIds !== undefined) patch.bingxOrderIds = input.bingxOrderIds;
  if (input.status !== undefined) patch.status = input.status;
  if (input.closedAt !== undefined) patch.closedAt = input.closedAt;
  if (input.closeReason !== undefined) patch.closeReason = input.closeReason;
  if (input.closePrice !== undefined) patch.closePrice = String(input.closePrice);
  if (input.resultR !== undefined) patch.resultR = String(input.resultR);
  if (input.resultPct !== undefined) patch.resultPct = String(input.resultPct);

  const [updated] = await db.update(trades).set(patch).where(eq(trades.id, id)).returning();
  return updated ?? null;
}

export type CloseTradeInput = {
  closedAt: Date;
  closeReason: string;
  closePrice: number;
  resultR: number;
  resultPct: number;
};

/**
 * Атомарно закрывает сделку, только если она ещё "active" (условие в самом WHERE).
 * Нужно, потому что закрытие теперь может прийти из двух независимых источников —
 * ручная кнопка и авто-детект по WS (Этап 4) — и они могут сработать почти одновременно.
 * Если строка не обновилась (null), значит сделку уже закрыл кто-то другой — статистику
 * по ней трогать повторно не нужно.
 */
export async function closeTradeIfActive(id: number, input: CloseTradeInput): Promise<Trade | null> {
  const db = getDb();
  const [updated] = await db
    .update(trades)
    .set({
      status: "closed",
      closedAt: input.closedAt,
      closeReason: input.closeReason,
      closePrice: String(input.closePrice),
      resultR: String(input.resultR),
      resultPct: String(input.resultPct),
    })
    .where(and(eq(trades.id, id), eq(trades.status, "active")))
    .returning();
  return updated ?? null;
}

/**
 * Обновляет MFE (лучшая цена в пользу сделки) и флаг пересечения безубытка (Этап 7).
 * Вызывается трекером активной сделки на каждое значимое изменение — не на каждый
 * тик цены, поэтому лишней нагрузки на БД не создаёт.
 */
export async function updateTradeTracking(
  id: number,
  input: { mfePrice: number; beCrossed: boolean },
): Promise<void> {
  const db = getDb();
  await db
    .update(trades)
    .set({ mfePrice: String(input.mfePrice), beCrossed: input.beCrossed })
    .where(eq(trades.id, id));
}

export type PagedTrades = { trades: Trade[]; total: number };

/** История — закрытые сделки, сначала новые. Пагинация минимальная (limit/offset), см. Этап 5. */
export async function listClosedTrades(options: { limit: number; offset: number }): Promise<PagedTrades> {
  const db = getDb();
  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(trades)
      .where(eq(trades.status, "closed"))
      .orderBy(desc(trades.closedAt))
      .limit(options.limit)
      .offset(options.offset),
    db.select({ value: count() }).from(trades).where(eq(trades.status, "closed")),
  ]);
  return { trades: rows, total: totalRow?.value ?? 0 };
}

/** Все закрытые сделки без пагинации — для инсайта по времени дня (history/insights.ts). Небольшой объём данных у одного пользователя, разовый запрос — не поллинг. */
export async function listAllClosedTradesForStats(): Promise<Array<Pick<Trade, "openedAt" | "resultR">>> {
  const db = getDb();
  return db
    .select({ openedAt: trades.openedAt, resultR: trades.resultR })
    .from(trades)
    .where(eq(trades.status, "closed"));
}

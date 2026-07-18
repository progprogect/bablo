import { eq } from "drizzle-orm";
import { getDb } from "../client.js";
import { dailyStats } from "../schema.js";
import { isStrongTakeProfit } from "../../risk/limits.js";

export type DailyStatsRow = typeof dailyStats.$inferSelect;

export async function getDailyStats(dateKey: string): Promise<DailyStatsRow | null> {
  const db = getDb();
  const [row] = await db.select().from(dailyStats).where(eq(dailyStats.date, dateKey)).limit(1);
  return row ?? null;
}

export async function getDailySumR(dateKey: string): Promise<number> {
  const row = await getDailyStats(dateKey);
  return row ? Number(row.sumR) : 0;
}

export type TradeCloseForDailyStats = {
  resultR: number;
  closeReason: string;
};

/**
 * Прибавляет результат сделки к дневному агрегату, создавая строку при необходимости.
 * Обновляет счётчики стопов/тейков и флаг «сильный откуп после стопа» — они нужны
 * правилам остановки торговли на день (см. risk/limits.ts).
 */
export async function addTradeResultToDailyStats(
  dateKey: string,
  trade: TradeCloseForDailyStats,
): Promise<DailyStatsRow> {
  const db = getDb();
  const existing = await getDailyStats(dateKey);
  const isStopLoss = trade.closeReason === "sl";
  const isTakeProfit = trade.closeReason === "tp";
  // Сильный откуп: тейк ≥ 2R, и к этому моменту за день уже был хотя бы один стоп.
  const strongRecovery =
    isTakeProfit && isStrongTakeProfit(trade.resultR) && (existing?.slCount ?? 0) > 0;

  if (!existing) {
    const [created] = await db
      .insert(dailyStats)
      .values({
        date: dateKey,
        sumR: String(trade.resultR),
        tradesCount: 1,
        slCount: isStopLoss ? 1 : 0,
        tpCount: isTakeProfit ? 1 : 0,
        strongRecoveryAfterSl: strongRecovery,
      })
      .returning();
    if (!created) {
      throw new Error("Не удалось создать daily_stats");
    }
    return created;
  }

  const [updated] = await db
    .update(dailyStats)
    .set({
      sumR: String(Number(existing.sumR) + trade.resultR),
      tradesCount: existing.tradesCount + 1,
      slCount: existing.slCount + (isStopLoss ? 1 : 0),
      tpCount: existing.tpCount + (isTakeProfit ? 1 : 0),
      // Флаг только включается (никогда не сбрасывается внутри дня).
      strongRecoveryAfterSl: existing.strongRecoveryAfterSl || strongRecovery,
    })
    .where(eq(dailyStats.date, dateKey))
    .returning();
  if (!updated) {
    throw new Error("Не удалось обновить daily_stats");
  }
  return updated;
}

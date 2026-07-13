import { eq } from "drizzle-orm";
import { getDb } from "../client.js";
import { dailyStats } from "../schema.js";

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

/** Прибавляет результат сделки (в R) к дневному агрегату, создавая строку при необходимости. */
export async function addTradeResultToDailyStats(dateKey: string, resultR: number): Promise<DailyStatsRow> {
  const db = getDb();
  const existing = await getDailyStats(dateKey);

  if (!existing) {
    const [created] = await db
      .insert(dailyStats)
      .values({ date: dateKey, sumR: String(resultR), tradesCount: 1 })
      .returning();
    if (!created) {
      throw new Error("Не удалось создать daily_stats");
    }
    return created;
  }

  const [updated] = await db
    .update(dailyStats)
    .set({
      sumR: String(Number(existing.sumR) + resultR),
      tradesCount: existing.tradesCount + 1,
    })
    .where(eq(dailyStats.date, dateKey))
    .returning();
  if (!updated) {
    throw new Error("Не удалось обновить daily_stats");
  }
  return updated;
}

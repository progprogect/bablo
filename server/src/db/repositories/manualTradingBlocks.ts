import { asc, gt } from "drizzle-orm";
import { getDb } from "../client.js";
import { manualTradingBlocks } from "../schema.js";

export type ManualTradingBlockRow = typeof manualTradingBlocks.$inferSelect;

/**
 * Блокировки, которые ещё действуют или только предстоят (endsAt в будущем), по времени
 * окончания. Истёкшие строки остаются в таблице историей, но ни гейту, ни настройкам
 * не нужны — их не читаем.
 */
export async function listRelevantManualBlocks(now: Date): Promise<ManualTradingBlockRow[]> {
  const db = getDb();
  return db
    .select()
    .from(manualTradingBlocks)
    .where(gt(manualTradingBlocks.endsAt, now))
    .orderBy(asc(manualTradingBlocks.endsAt));
}

export async function insertManualBlock(block: {
  kind: "hour" | "window";
  hour: number | null;
  startsAt: Date;
  endsAt: Date;
}): Promise<ManualTradingBlockRow> {
  const db = getDb();
  const [row] = await db.insert(manualTradingBlocks).values(block).returning();
  return row!;
}

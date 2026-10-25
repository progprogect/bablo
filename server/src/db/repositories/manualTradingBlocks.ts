import { asc, gt } from "drizzle-orm";
import { getDb } from "../client.js";
import { manualTradingBlocks } from "../schema.js";

export type ManualTradingBlockRow = typeof manualTradingBlocks.$inferSelect;

/**
 * Блокировки, закончившиеся позже `since`, по времени окончания. `since` в прошлом даёт
 * вместе с действующими и недавно истёкшие — их читают уведомления на главной
 * (risk/dayNotices.ts), чтобы сказать «час снова открыт» уже после снятия блокировки.
 */
export async function listManualBlocksEndingAfter(since: Date): Promise<ManualTradingBlockRow[]> {
  const db = getDb();
  return db
    .select()
    .from(manualTradingBlocks)
    .where(gt(manualTradingBlocks.endsAt, since))
    .orderBy(asc(manualTradingBlocks.endsAt));
}

/**
 * Блокировки, которые ещё действуют или только предстоят (endsAt в будущем). Истёкшие
 * строки остаются в таблице историей, но ни гейту, ни настройкам не нужны — их не читаем.
 */
export async function listRelevantManualBlocks(now: Date): Promise<ManualTradingBlockRow[]> {
  return listManualBlocksEndingAfter(now);
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

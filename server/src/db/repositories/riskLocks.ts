import { gt, inArray } from "drizzle-orm";
import { getDb } from "../client.js";
import { riskLocks } from "../schema.js";
import type { Block, BlockType } from "../../risk/limits.js";

export type RiskLockRow = typeof riskLocks.$inferSelect;

const MANAGED_TYPES: BlockType[] = ["cooldown", "daily_loss", "daily_profit", "daily_stop_losses"];

export async function listActiveLocks(now: Date = new Date()): Promise<RiskLockRow[]> {
  const db = getDb();
  return db.select().from(riskLocks).where(gt(riskLocks.until, now));
}

/**
 * Полностью пересобирает управляемые типы блокировок (cooldown/daily_loss/daily_profit)
 * из свежего расчёта чистой risk-логики. Вызывается один раз после закрытия сделки —
 * гарантирует отсутствие рассинхронизации со старыми записями.
 */
export async function replaceManagedLocks(blocks: Block[]): Promise<void> {
  const db = getDb();
  await db.delete(riskLocks).where(inArray(riskLocks.type, MANAGED_TYPES));
  if (blocks.length === 0) {
    return;
  }
  await db.insert(riskLocks).values(
    blocks.map((b) => ({ type: b.type, reason: b.reason, until: b.until })),
  );
}

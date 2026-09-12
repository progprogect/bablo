import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "../client.js";
import { hourBlocks } from "../schema.js";
import type { HourBlockDecision } from "../../risk/hourBlocks.js";

export type HourBlockRow = typeof hourBlocks.$inferSelect;

/** Активные блокировки часов (unblockedAt = null), по возрастанию часа. */
export async function listActiveHourBlocks(): Promise<HourBlockRow[]> {
  const db = getDb();
  return db.select().from(hourBlocks).where(isNull(hourBlocks.unblockedAt)).orderBy(asc(hourBlocks.hour));
}

/**
 * Применяет решение чистого правила: заводит новые блокировки и закрывает снятые.
 * Идемпотентно по смыслу — в decision попадают только реальные переходы.
 */
export async function applyHourBlockDecision(decision: HourBlockDecision, now: Date): Promise<void> {
  const db = getDb();

  for (const entry of decision.toUnblock) {
    await db
      .update(hourBlocks)
      .set({ unblockedAt: now, referenceAtUnblock: entry.reference })
      .where(and(eq(hourBlocks.hour, entry.hour), isNull(hourBlocks.unblockedAt)));
  }

  if (decision.toBlock.length > 0) {
    await db.insert(hourBlocks).values(
      decision.toBlock.map((entry) => ({
        hour: entry.hour,
        blockedAt: now,
        tradesAtBlock: entry.total,
        tpAtBlock: entry.tpCount,
        referenceAtBlock: entry.reference,
      })),
    );
  }
}

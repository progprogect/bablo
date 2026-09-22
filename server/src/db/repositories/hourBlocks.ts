import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../client.js";
import { hourBlocks } from "../schema.js";
import type { HourBlockDecision } from "../../risk/hourBlocks.js";
import { MANUAL_HOUR_BLOCK_SOURCE } from "../../risk/hourBlockReview.js";

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

/**
 * Снимает активные блокировки перечисленных часов. Используется проверкой ручных
 * блокировок (risk/hourBlockReview.ts) и кнопкой «открыть» в админке — в отличие от
 * applyHourBlockDecision, здесь снимаются часы независимо от происхождения.
 */
export async function unblockHours(hours: number[], now: Date): Promise<number> {
  if (hours.length === 0) return 0;
  const db = getDb();
  const updated = await db
    .update(hourBlocks)
    .set({ unblockedAt: now })
    .where(and(inArray(hourBlocks.hour, hours), isNull(hourBlocks.unblockedAt)))
    .returning({ hour: hourBlocks.hour });
  return updated.length;
}

/**
 * Помечает проверку ручных блокировок выполненной: гипотеза подтвердилась, час остаётся
 * закрытым бессрочно и больше не проверяется (решение от 22.09.2026).
 */
export async function markHourBlocksReviewed(hours: number[], now: Date): Promise<void> {
  if (hours.length === 0) return;
  const db = getDb();
  await db
    .update(hourBlocks)
    .set({ reviewedAt: now })
    .where(
      and(
        inArray(hourBlocks.hour, hours),
        isNull(hourBlocks.unblockedAt),
        eq(hourBlocks.source, MANUAL_HOUR_BLOCK_SOURCE),
      ),
    );
}

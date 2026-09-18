import { asc, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../client.js";
import { levelWithdrawals } from "../schema.js";

export type LevelWithdrawalRow = typeof levelWithdrawals.$inferSelect;

/** Незакрытые требования вывода (withdrawnAt = null), сначала старые. */
export async function listPendingWithdrawals(): Promise<LevelWithdrawalRow[]> {
  const db = getDb();
  return db
    .select()
    .from(levelWithdrawals)
    .where(isNull(levelWithdrawals.withdrawnAt))
    .orderBy(asc(levelWithdrawals.level));
}

/** Вся история: и сделанные выводы, и ожидающие — сначала свежие. */
export async function listLevelWithdrawals(): Promise<LevelWithdrawalRow[]> {
  const db = getDb();
  return db.select().from(levelWithdrawals).orderBy(desc(levelWithdrawals.id));
}

/** Требование вывода за пройденный уровень. */
export async function createWithdrawalRequirement(input: {
  level: number;
  requiredUsd: number;
  createdAt?: Date;
}): Promise<LevelWithdrawalRow> {
  const db = getDb();
  const [row] = await db
    .insert(levelWithdrawals)
    .values({
      level: input.level,
      requiredUsd: String(input.requiredUsd),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning();
  if (!row) throw new Error("Не удалось создать требование вывода");
  return row;
}

/** Отмечает требование выполненным. Возвращает null, если его уже закрыли параллельно. */
export async function markWithdrawalDone(
  id: number,
  input: {
    withdrawnUsd: number;
    withdrawnAt: Date;
    source: "manual" | "bingx";
    externalId?: string | null;
    equityAdjustmentId?: number | null;
  },
): Promise<LevelWithdrawalRow | null> {
  const db = getDb();
  const [row] = await db
    .update(levelWithdrawals)
    .set({
      withdrawnUsd: String(input.withdrawnUsd),
      withdrawnAt: input.withdrawnAt,
      source: input.source,
      externalId: input.externalId ?? null,
      equityAdjustmentId: input.equityAdjustmentId ?? null,
    })
    .where(eq(levelWithdrawals.id, id))
    .returning();
  return row ?? null;
}

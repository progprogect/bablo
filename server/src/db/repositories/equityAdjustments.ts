import { eq } from "drizzle-orm";
import { getDb } from "../client.js";
import { equityAdjustments } from "../schema.js";

export type EquityAdjustmentRow = typeof equityAdjustments.$inferSelect;

export type CreateEquityAdjustmentInput = {
  date: string; // YYYY-MM-DD
  amountUsd: number; // + пополнение, − вывод
  note?: string | null;
};

/** Все корректировки по возрастанию даты — используются при восстановлении баланса прошлых месяцев (history/monthlyStats.ts). */
export async function listEquityAdjustments(): Promise<EquityAdjustmentRow[]> {
  const db = getDb();
  return db.select().from(equityAdjustments).orderBy(equityAdjustments.date);
}

export async function createEquityAdjustment(input: CreateEquityAdjustmentInput): Promise<EquityAdjustmentRow> {
  const db = getDb();
  const [row] = await db
    .insert(equityAdjustments)
    .values({ date: input.date, amountUsd: String(input.amountUsd), note: input.note ?? null })
    .returning();
  if (!row) throw new Error("Не удалось сохранить корректировку баланса");
  return row;
}

export async function deleteEquityAdjustment(id: number): Promise<void> {
  const db = getDb();
  await db.delete(equityAdjustments).where(eq(equityAdjustments.id, id));
}

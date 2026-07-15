import { desc } from "drizzle-orm";
import { getDb } from "../client.js";
import { equitySnapshots } from "../schema.js";

export type EquitySnapshotRow = typeof equitySnapshots.$inferSelect;

/** Самый свежий снимок эквити — точка отсчёта для восстановления баланса прошлых месяцев (history/monthlyStats.ts). Null, если снимков ещё не было. */
export async function getLatestEquitySnapshot(): Promise<EquitySnapshotRow | null> {
  const db = getDb();
  const [row] = await db.select().from(equitySnapshots).orderBy(desc(equitySnapshots.date)).limit(1);
  return row ?? null;
}

/**
 * Создаёт снимок эквити на дату, если его ещё нет — не перезаписывает существующий.
 * Best-effort: вызывается лениво из GET /dashboard (см. api/dashboard.ts), максимум
 * одна запись в день, без отдельного планировщика.
 */
export async function captureEquitySnapshotIfMissing(dateKey: string, equity: number): Promise<void> {
  const db = getDb();
  await db
    .insert(equitySnapshots)
    .values({ date: dateKey, equity: String(equity) })
    .onConflictDoNothing();
}

/** Все снимки эквити по возрастанию даты — для графика роста депозита (docs/PROJECT.md, исключение из принципа "без графиков"). */
export async function listEquitySnapshots(): Promise<EquitySnapshotRow[]> {
  const db = getDb();
  return db.select().from(equitySnapshots).orderBy(equitySnapshots.date);
}

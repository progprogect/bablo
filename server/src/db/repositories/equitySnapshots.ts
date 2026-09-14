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
export async function captureEquitySnapshotIfMissing(
  dateKey: string,
  equity: number,
  balance: number | null = null,
): Promise<void> {
  const db = getDb();
  await db
    .insert(equitySnapshots)
    .values({
      date: dateKey,
      equity: String(equity),
      balance: balance === null ? null : String(balance),
    })
    .onConflictDoNothing();
}

/**
 * Перезаписывает снимок эквити на дату (в отличие от captureEquitySnapshotIfMissing).
 * Нужен для кнопки «Обновить баланс» в админке: снимок дня создаётся при первой за день
 * загрузке дашборда, а после сделок/пополнения он устаревает — статистика месяца считает
 * «депозит на конец месяца» именно по снимкам (history/monthlyStats.ts).
 */
export async function upsertEquitySnapshot(
  dateKey: string,
  equity: number,
  balance: number | null = null,
): Promise<void> {
  const db = getDb();
  const values = {
    date: dateKey,
    equity: String(equity),
    balance: balance === null ? null : String(balance),
  };
  await db
    .insert(equitySnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: equitySnapshots.date,
      set: { equity: values.equity, balance: values.balance, capturedAt: new Date() },
    });
}

/** Все снимки эквити по возрастанию даты — для графика роста депозита (docs/PROJECT.md, исключение из принципа "без графиков"). */
export async function listEquitySnapshots(): Promise<EquitySnapshotRow[]> {
  const db = getDb();
  return db.select().from(equitySnapshots).orderBy(equitySnapshots.date);
}

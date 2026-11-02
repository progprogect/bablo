import { getDb } from "../client.js";
import { hourBaseline } from "../schema.js";
import type { HourBaselineEntry } from "../../history/hourBaseline.js";

/**
 * Стартовая статистика по часам (history/hourBaseline.ts): сколько сделок и сколько из
 * них тейком было до появления этой базы. Таблица маленькая — максимум 24 строки.
 */
export async function listHourBaseline(): Promise<HourBaselineEntry[]> {
  const db = getDb();
  const rows = await db.select().from(hourBaseline);
  return rows
    .map((row) => ({ hour: row.hour, total: row.total, tpCount: row.tpCount }))
    .sort((a, b) => a.hour - b.hour);
}

/**
 * Полная замена стартовой статистики: пользователь вставляет список целиком, поэтому
 * правка — это всегда новый набор, а не дописывание к старому. Пустой список очищает
 * таблицу и возвращает гистограмму к чистому счёту по реальным сделкам.
 */
export async function replaceHourBaseline(entries: HourBaselineEntry[]): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(hourBaseline);
    if (entries.length === 0) return;
    await tx.insert(hourBaseline).values(
      entries.map((entry) => ({ hour: entry.hour, total: entry.total, tpCount: entry.tpCount })),
    );
  });
}

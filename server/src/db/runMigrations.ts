import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { requireDatabaseUrl } from "../config/env.js";

/**
 * Применяет миграции Drizzle. Идемпотентно (drizzle сам трекает применённые миграции) —
 * безопасно вызывать при каждом старте сервера. Используется и из CLI-скрипта (npm run
 * db:migrate / releaseCommand на Railway), и напрямую из bootstrap в index.ts — так схема
 * гарантированно на месте перед первым запросом, даже если отдельная release-стадия
 * по какой-то причине не выполнилась.
 */
export async function runMigrations(): Promise<void> {
  const sql = postgres(requireDatabaseUrl(), { max: 1 });
  try {
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: "./drizzle" });
  } finally {
    await sql.end();
  }
}

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { requireDatabaseUrl } from "../config/env.js";
import * as schema from "./schema.js";

let sqlClient: ReturnType<typeof postgres> | undefined;

/** Ленивая инициализация: до первого обращения к БД сервер стартует даже без DATABASE_URL. */
export function getDb() {
  if (!sqlClient) {
    sqlClient = postgres(requireDatabaseUrl(), { max: 5 });
  }
  return drizzle(sqlClient, { schema });
}

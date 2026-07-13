import { asc, eq } from "drizzle-orm";
import { getDb } from "../client.js";
import { riskLevels } from "../schema.js";
import { DEFAULT_RISK_LEVELS } from "../../risk/defaultLevels.js";
import type { RiskLevelDef } from "../../risk/ladder.js";

export type RiskLevelRow = typeof riskLevels.$inferSelect;

/** Идемпотентный сид лестницы уровней из docs/RISK_ENGINE.md, если таблица пуста. */
export async function ensureSeedRiskLevels(): Promise<void> {
  const db = getDb();
  const existing = await db.select({ id: riskLevels.id }).from(riskLevels).limit(1);
  if (existing.length > 0) {
    return;
  }
  await db.insert(riskLevels).values(
    DEFAULT_RISK_LEVELS.map((l) => ({
      level: l.level,
      riskUsd: String(l.riskUsd),
      requiredR: String(l.requiredR),
    })),
  );
}

export async function listRiskLevels(): Promise<RiskLevelRow[]> {
  const db = getDb();
  return db.select().from(riskLevels).orderBy(asc(riskLevels.level));
}

/** Лестница как чистые числовые определения — для передачи в pure risk-логику. */
export async function listRiskLevelDefs(): Promise<RiskLevelDef[]> {
  const rows = await listRiskLevels();
  return rows.map((r) => ({
    level: r.level,
    riskUsd: Number(r.riskUsd),
    requiredR: Number(r.requiredR),
  }));
}

export async function updateRiskLevel(
  level: number,
  input: { riskUsd?: number; requiredR?: number },
): Promise<RiskLevelRow | null> {
  const db = getDb();
  const patch: Record<string, unknown> = {};
  if (input.riskUsd !== undefined) patch.riskUsd = String(input.riskUsd);
  if (input.requiredR !== undefined) patch.requiredR = String(input.requiredR);
  const [updated] = await db.update(riskLevels).set(patch).where(eq(riskLevels.level, level)).returning();
  return updated ?? null;
}

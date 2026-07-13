import { eq } from "drizzle-orm";
import { getDb } from "../client.js";
import { riskState } from "../schema.js";
import type { RiskState } from "../../risk/ladder.js";

export type RiskStateRow = typeof riskState.$inferSelect;

/** risk_state — singleton (одна строка на всё приложение). Создаётся при первом обращении. */
export async function getOrCreateRiskState(): Promise<RiskStateRow> {
  const db = getDb();
  const [existing] = await db.select().from(riskState).limit(1);
  if (existing) {
    return existing;
  }
  const [created] = await db.insert(riskState).values({}).returning();
  if (!created) {
    throw new Error("Не удалось создать risk_state");
  }
  return created;
}

export async function updateRiskState(id: number, state: RiskState): Promise<RiskStateRow | null> {
  const db = getDb();
  const [updated] = await db
    .update(riskState)
    .set({
      currentLevel: state.currentLevel,
      accumulatedR: String(state.accumulatedR),
      updatedAt: new Date(),
    })
    .where(eq(riskState.id, id))
    .returning();
  return updated ?? null;
}

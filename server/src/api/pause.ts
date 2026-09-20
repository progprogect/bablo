import type { FastifyInstance } from "fastify";
import { createLock, listActiveLocks } from "../db/repositories/riskLocks.js";
import { buildVoluntaryPauseBlock } from "../risk/limits.js";
import { requireAuth } from "./plugins/auth-guard.js";

/**
 * Добровольная пауза «поберечь депозит до лучшего входа» (docs/RISK_ENGINE.md, правило
 * #13): кнопка на дашборде закрывает открытие сделок на два часа. Это единственная
 * блокировка, которую пользователь ставит себе сам — чтобы у сомнения был простой выход,
 * не требующий силы воли в момент, когда её меньше всего.
 */
export async function registerPauseRoutes(app: FastifyInstance): Promise<void> {
  app.post("/pause", { preHandler: requireAuth }, async () => {
    const now = new Date();
    const block = buildVoluntaryPauseBlock(now);
    await createLock(block);
    return {
      type: block.type,
      reason: block.reason,
      until: block.until.toISOString(),
      activeLocks: (await listActiveLocks(now)).length,
    };
  });
}

import type { FastifyInstance } from "fastify";
import { listAllClosedTradesForStats } from "../db/repositories/trades.js";
import { getRiskSettings } from "../db/repositories/settings.js";
import { computeTimeOfDayStats } from "../history/insights.js";
import { requireAuth } from "./plugins/auth-guard.js";

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/stats", { preHandler: requireAuth }, async () => {
    const [rows, riskSettings] = await Promise.all([listAllClosedTradesForStats(), getRiskSettings()]);
    const trades = rows.map((row) => ({
      openedAt: row.openedAt,
      resultR: row.resultR !== null ? Number(row.resultR) : null,
    }));
    return computeTimeOfDayStats(trades, riskSettings.tzOffsetMinutes);
  });
}

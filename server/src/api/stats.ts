import type { FastifyInstance } from "fastify";
import { listEquityAdjustments } from "../db/repositories/equityAdjustments.js";
import { getLatestEquitySnapshot, listEquitySnapshots } from "../db/repositories/equitySnapshots.js";
import { getRiskSettings } from "../db/repositories/settings.js";
import { listAllClosedTrades } from "../db/repositories/trades.js";
import { computeTradeInsights, type InsightTradeInput } from "../history/insights.js";
import { computeMonthlyStats, type EquityAnchor, type MonthlyStatTradeInput } from "../history/monthlyStats.js";
import { requireAuth } from "./plugins/auth-guard.js";

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/stats", { preHandler: requireAuth }, async () => {
    const [rows, riskSettings, latestSnapshot, adjustmentRows] = await Promise.all([
      listAllClosedTrades(),
      getRiskSettings(),
      getLatestEquitySnapshot(),
      listEquityAdjustments(),
    ]);

    const insightInputs: InsightTradeInput[] = rows.map((row) => ({
      symbol: row.symbol,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      closeReason: row.closeReason,
      resultR: row.resultR !== null ? Number(row.resultR) : null,
      riskUsd: row.riskUsd !== null ? Number(row.riskUsd) : null,
      rrPreset: row.rrPreset,
    }));
    const insights = computeTradeInsights(
      insightInputs,
      riskSettings.tzOffsetMinutes,
      riskSettings.dailyProfitLimitR,
    );

    const monthlyInputs: MonthlyStatTradeInput[] = rows.map((row) => ({
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      closeReason: row.closeReason,
      resultR: row.resultR !== null ? Number(row.resultR) : null,
      riskUsd: row.riskUsd !== null ? Number(row.riskUsd) : null,
      rrPreset: row.rrPreset,
    }));

    // Якорь — последний известный снимок эквити. От него computeMonthlyStats "откручивает"
    // назад баланс на начало каждого прошлого месяца (см. history/monthlyStats.ts), поэтому
    // отдельный снимок ровно на начало месяца не требуется.
    const anchor: EquityAnchor | null = latestSnapshot
      ? { date: latestSnapshot.date, equity: Number(latestSnapshot.equity) }
      : null;
    const adjustments = adjustmentRows.map((row) => ({ date: row.date, amountUsd: Number(row.amountUsd) }));

    const monthly = computeMonthlyStats(monthlyInputs, riskSettings.tzOffsetMinutes, anchor, adjustments);

    return { insights, monthly };
  });

  /**
   * Явное исключение из принципа "без графиков" (docs/PROJECT.md) — по запросу пользователя.
   * Точки берём из equity_snapshots (один снимок в день, см. api/dashboard.ts): график растёт
   * только "вперёд" с момента появления этой таблицы, без восстановления прошлых точек.
   */
  app.get("/stats/equity-history", { preHandler: requireAuth }, async () => {
    const snapshots = await listEquitySnapshots();
    return snapshots.map((snapshot) => ({ date: snapshot.date, equity: Number(snapshot.equity) }));
  });
}

import type { FastifyInstance } from "fastify";
import { listEquityAdjustments } from "../db/repositories/equityAdjustments.js";
import { listEquitySnapshots } from "../db/repositories/equitySnapshots.js";
import { getRiskSettings } from "../db/repositories/settings.js";
import { listAllClosedTrades } from "../db/repositories/trades.js";
import { computeTradeInsights, type InsightTradeInput } from "../history/insights.js";
import { computeMonthlyStats, type EquityAnchor, type MonthlyStatTradeInput } from "../history/monthlyStats.js";
import { requireAuth } from "./plugins/auth-guard.js";

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/stats", { preHandler: requireAuth }, async () => {
    const [rows, riskSettings, snapshotRows, adjustmentRows] = await Promise.all([
      listAllClosedTrades(),
      getRiskSettings(),
      listEquitySnapshots(),
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
      entryPrice: row.entryPrice !== null ? Number(row.entryPrice) : null,
      slPrice: row.slPrice !== null ? Number(row.slPrice) : null,
      side: row.side,
      statsOutcome: row.statsOutcome,
      statsRrPreset: row.statsRrPreset,
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
      entryPrice: row.entryPrice !== null ? Number(row.entryPrice) : null,
      slPrice: row.slPrice !== null ? Number(row.slPrice) : null,
      side: row.side,
      quantity: Number(row.quantity),
      partialTpPrice: row.partialTpPrice !== null ? Number(row.partialTpPrice) : null,
      partialTpFilledAt: row.partialTpFilledAt,
      nightTpAppliedAt: row.nightTpAppliedAt,
      statsRrPreset: row.statsRrPreset,
      statsOutcome: row.statsOutcome,
    }));

    // Все дневные снимки эквити: границы месяцев считаются от БЛИЖАЙШЕГО к границе
    // снимка (см. history/monthlyStats.ts), последний снимок — якорь «сейчас»
    // для текущего месяца.
    const snapshots: EquityAnchor[] = snapshotRows.map((row) => ({
      date: row.date,
      equity: Number(row.equity),
      balance: row.balance !== null ? Number(row.balance) : null,
    }));
    const anchor: EquityAnchor | null = snapshots.length > 0 ? snapshots[snapshots.length - 1]! : null;
    const adjustments = adjustmentRows.map((row) => ({ date: row.date, amountUsd: Number(row.amountUsd) }));

    const monthly = computeMonthlyStats(
      monthlyInputs,
      riskSettings.tzOffsetMinutes,
      anchor,
      adjustments,
      new Date(),
      snapshots,
    );

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

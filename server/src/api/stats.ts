import type { FastifyInstance } from "fastify";
import { getFirstEquitySnapshotInRange, listEquitySnapshots } from "../db/repositories/equitySnapshots.js";
import { getRiskSettings } from "../db/repositories/settings.js";
import { listAllClosedTrades } from "../db/repositories/trades.js";
import { computeTradeInsights, type InsightTradeInput } from "../history/insights.js";
import { computeMonthlyStats, type MonthlyStatTradeInput } from "../history/monthlyStats.js";
import { getLocalDateKey } from "../risk/tradingDay.js";
import { requireAuth } from "./plugins/auth-guard.js";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/stats", { preHandler: requireAuth }, async () => {
    const [rows, riskSettings] = await Promise.all([listAllClosedTrades(), getRiskSettings()]);

    const insightInputs: InsightTradeInput[] = rows.map((row) => ({
      symbol: row.symbol,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      closeReason: row.closeReason,
      resultR: row.resultR !== null ? Number(row.resultR) : null,
      riskUsd: row.riskUsd !== null ? Number(row.riskUsd) : null,
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

    // Точечно запрашиваем снимок эквити только для месяцев, в которых реально есть закрытые сделки.
    const monthKeys = new Set<string>();
    for (const trade of monthlyInputs) {
      if (trade.resultR === null || !trade.closedAt) continue;
      monthKeys.add(getLocalDateKey(trade.closedAt, riskSettings.tzOffsetMinutes).slice(0, 7));
    }

    const baselineByMonth = new Map<string, number | null>();
    await Promise.all(
      Array.from(monthKeys).map(async (yearMonth) => {
        const parts = yearMonth.split("-").map(Number);
        const year = parts[0]!;
        const month = parts[1]!;
        const fromKey = `${yearMonth}-01`;
        const toKey = `${yearMonth}-${pad2(lastDayOfMonth(year, month))}`;
        const snapshot = await getFirstEquitySnapshotInRange(fromKey, toKey);
        baselineByMonth.set(yearMonth, snapshot ? Number(snapshot.equity) : null);
      }),
    );

    const monthly = computeMonthlyStats(monthlyInputs, riskSettings.tzOffsetMinutes, (year, month) =>
      baselineByMonth.get(`${year}-${pad2(month)}`) ?? null,
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

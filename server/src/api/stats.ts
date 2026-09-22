import type { FastifyInstance } from "fastify";
import { listEquityAdjustments } from "../db/repositories/equityAdjustments.js";
import { listEquitySnapshots } from "../db/repositories/equitySnapshots.js";
import { getRiskSettings } from "../db/repositories/settings.js";
import { listAllClosedTrades } from "../db/repositories/trades.js";
import { computeTradeInsights, toInsightInput } from "../history/insights.js";
import {
  computeMonthlyStats,
  toMonthlyStatInput,
  withOrphanWithdrawals,
  type ConfirmedWithdrawalInput,
  type EquityAnchor,
  type MonthlyStatTradeInput,
} from "../history/monthlyStats.js";
import { listLevelWithdrawals } from "../db/repositories/levelWithdrawals.js";
import { getLocalDateKey } from "../risk/tradingDay.js";
import { listBlockedHours } from "../risk/hourBlocksService.js";
import { requireAuth } from "./plugins/auth-guard.js";

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/stats", { preHandler: requireAuth }, async () => {
    const [rows, riskSettings, snapshotRows, adjustmentRows, blockedHours, withdrawalRows] =
      await Promise.all([
        listAllClosedTrades(),
        getRiskSettings(),
        listEquitySnapshots(),
        listEquityAdjustments(),
        listBlockedHours(),
        listLevelWithdrawals(),
      ]);

    const insights = computeTradeInsights(rows.map(toInsightInput), riskSettings.tzOffsetMinutes);

    const monthlyInputs: MonthlyStatTradeInput[] = rows.map(toMonthlyStatInput);

    // Все дневные снимки эквити: границы месяцев считаются от БЛИЖАЙШЕГО к границе
    // снимка (см. history/monthlyStats.ts), последний снимок — якорь «сейчас»
    // для текущего месяца.
    const snapshots: EquityAnchor[] = snapshotRows.map((row) => ({
      date: row.date,
      equity: Number(row.equity),
      balance: row.balance !== null ? Number(row.balance) : null,
    }));
    const anchor: EquityAnchor | null = snapshots.length > 0 ? snapshots[snapshots.length - 1]! : null;
    // Выведенная на карту прибыль не должна занижать % месяца: она уже лежит в
    // корректировках, а потерявшие корректировку выводы добавляются синтетически
    // (see history/monthlyStats.ts → withOrphanWithdrawals).
    const confirmedWithdrawals: ConfirmedWithdrawalInput[] = withdrawalRows
      .filter((row) => row.withdrawnAt !== null && row.withdrawnUsd !== null)
      .map((row) => ({
        date: getLocalDateKey(row.withdrawnAt!, riskSettings.tzOffsetMinutes),
        amountUsd: Number(row.withdrawnUsd),
        equityAdjustmentId: row.equityAdjustmentId,
      }));
    const adjustments = withOrphanWithdrawals(
      adjustmentRows.map((row) => ({ date: row.date, amountUsd: Number(row.amountUsd) })),
      confirmedWithdrawals,
      adjustmentRows.map((row) => row.id),
    );

    const monthly = computeMonthlyStats(
      monthlyInputs,
      riskSettings.tzOffsetMinutes,
      anchor,
      adjustments,
      new Date(),
      snapshots,
    );

    // Смещение таймзоны риск-плана — по нему сгруппированы часы в insights, по нему же
    // UI (InsightPanel) подсвечивает текущий час: время устройства может не совпадать.
    // blockedHours — часы, закрытые правилом убыточных часов (пусто, если оно выключено).
    // Происхождение блокировки (расчёт или решение пользователя) наружу не отдаётся:
    // в подсказке у обеих один и тот же замок, отдельное пояснение убрано 23.09.2026.
    return { insights, monthly, tzOffsetMinutes: riskSettings.tzOffsetMinutes, blockedHours };
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

import { listManualBlocksEndingAfter } from "../db/repositories/manualTradingBlocks.js";
import { getRiskSettings } from "../db/repositories/settings.js";
import { buildDayNotices, NOTICE_HISTORY_MS, type DayNotice } from "./dayNotices.js";

/**
 * I/O-обвязка уведомлений главного экрана: решение — в dayNotices.ts, здесь только
 * чтение настроек и закрытых часов (включая недавно истёкшие). Разделение то же, что у
 * дневных лимитов (limits.ts + service.ts) и ручных блокировок.
 */
export async function listDayNotices(now: Date = new Date()): Promise<DayNotice[]> {
  const [rows, settings] = await Promise.all([
    listManualBlocksEndingAfter(new Date(now.getTime() - NOTICE_HISTORY_MS)),
    getRiskSettings(),
  ]);
  const hourBlocks = rows
    .filter((row) => row.kind === "hour" && row.hour !== null)
    .map((row) => ({ hour: row.hour as number, endsAt: row.endsAt }));
  return buildDayNotices({
    now,
    resetHour: settings.resetHour,
    tzOffsetMinutes: settings.tzOffsetMinutes,
    hourBlocks,
  });
}

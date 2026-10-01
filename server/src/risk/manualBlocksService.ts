import {
  insertManualBlock,
  listRelevantManualBlocks,
  type ManualTradingBlockRow,
} from "../db/repositories/manualTradingBlocks.js";
import { getRiskSettings } from "../db/repositories/settings.js";
import {
  buildWindow,
  describeManualBlock,
  hoursBlockedAt,
  validateHourBlockInput,
  type ManualBlock,
} from "./manualBlocks.js";
import type { Block } from "./limits.js";

/**
 * I/O-обвязка ручных блокировок торговли: чистые решения — в manualBlocks.ts, здесь —
 * чтение/запись таблицы manual_trading_blocks и сборка ответов для API. Разделение то же,
 * что у дневных лимитов (limits.ts + service.ts).
 */

/** Ошибка валидации заявки на блокировку — API превращает её в ответ 400/409. */
export class ManualBlockValidationError extends Error {}

function toManualBlock(row: ManualTradingBlockRow): ManualBlock {
  if (row.kind === "hour") {
    return { kind: "hour", hour: row.hour ?? 0, endsAt: row.endsAt };
  }
  return { kind: "window", startsAt: row.startsAt, endsAt: row.endsAt };
}

/** Блокировка «сейчас действует ручная блокировка» для риск-гейта и дашборда, или null. */
export async function evaluateManualTradingBlock(now: Date = new Date()): Promise<Block | null> {
  const rows = await listRelevantManualBlocks(now);
  if (rows.length === 0) return null;
  const settings = await getRiskSettings();
  return describeManualBlock(now, rows.map(toManualBlock), settings.tzOffsetMinutes);
}

/** Часы, закрытые ручной блокировкой прямо сейчас, — замки в гистограмме подсказки. */
export async function listCurrentlyBlockedHours(now: Date = new Date()): Promise<number[]> {
  const rows = await listRelevantManualBlocks(now);
  return hoursBlockedAt(now, rows.map(toManualBlock));
}

export type ManualBlocksView = {
  /** Таймзона риск-плана: в ней заданы часы и окна, в ней UI показывает время. */
  tzOffsetMinutes: number;
  /** Закрытые часы, по возрастанию часа. */
  hours: { id: number; hour: number; endsAt: string }[];
  /** Активные и предстоящие окна, по времени начала. */
  windows: { id: number; startsAt: string; endsAt: string }[];
};

/** Действующие и предстоящие блокировки для экрана настроек. */
export async function listManualBlocksView(now: Date = new Date()): Promise<ManualBlocksView> {
  const [rows, settings] = await Promise.all([listRelevantManualBlocks(now), getRiskSettings()]);
  const hours = rows
    .filter((row) => row.kind === "hour")
    .map((row) => ({ id: row.id, hour: row.hour ?? 0, endsAt: row.endsAt.toISOString() }))
    .sort((a, b) => a.hour - b.hour);
  const windows = rows
    .filter((row) => row.kind === "window")
    .map((row) => ({ id: row.id, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() }))
    .sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0));
  return { tzOffsetMinutes: settings.tzOffsetMinutes, hours, windows };
}

const DAY_MS = 86_400_000;

/** Закрыть час суток на `days` дней. Снять блокировку до истечения срока нельзя. */
export async function blockHour(hour: number, days: number, now: Date = new Date()): Promise<void> {
  const rows = await listRelevantManualBlocks(now);
  const activeHours = hoursBlockedAt(now, rows.map(toManualBlock));
  const error = validateHourBlockInput({ hour, days }, activeHours);
  if (error) throw new ManualBlockValidationError(error);
  await insertManualBlock({
    kind: "hour",
    hour,
    startsAt: now,
    endsAt: new Date(now.getTime() + days * DAY_MS),
  });
}

/** Запланировать окно блокировки: дата + время «с … до» в таймзоне риск-плана. */
export async function scheduleWindow(
  input: { date: string; from: string; to: string },
  now: Date = new Date(),
): Promise<void> {
  const settings = await getRiskSettings();
  const window = buildWindow(input, now, settings.tzOffsetMinutes);
  if ("error" in window) throw new ManualBlockValidationError(window.error);
  await insertManualBlock({ kind: "window", hour: null, startsAt: window.startsAt, endsAt: window.endsAt });
}

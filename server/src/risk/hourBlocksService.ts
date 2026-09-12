import { applyHourBlockDecision, listActiveHourBlocks } from "../db/repositories/hourBlocks.js";
import { getRiskSettings } from "../db/repositories/settings.js";
import { listAllClosedTrades } from "../db/repositories/trades.js";
import { computeTradeInsights, toInsightInput } from "../history/insights.js";
import {
  decideHourBlocks,
  formatHour,
  nextProfitableHour,
  openHourAfter,
  type HourBlockDecision,
  type HourOutcome,
} from "./hourBlocks.js";
import type { Block } from "./limits.js";
import { getLocalHour } from "./tradingDay.js";

/**
 * I/O-обвязка правила убыточных часов: чистые решения живут в hourBlocks.ts, здесь —
 * чтение статистики, хранение состояния (таблица hour_blocks) и сборка блокировки для
 * риск-гейта. Разделение то же, что у дневных лимитов: limits.ts (чистое) + service.ts.
 */

/** Статистика по часам открытия — тот же расчёт, что показывает подсказка в истории. */
async function loadHourOutcomes(tzOffsetMinutes: number): Promise<HourOutcome[]> {
  const rows = await listAllClosedTrades();
  return computeTradeInsights(rows.map(toInsightInput), tzOffsetMinutes).hourlyOutcomes;
}

/**
 * Пересчитывает набор заблокированных часов по свежей статистике и сохраняет переходы.
 * Вызывается там, где меняется статистика часов: после закрытия сделки, после ручной
 * переразметки исхода в админке и при старте сервера. Состояние обновляется независимо
 * от тумблера: выключенное правило не должно «терять» историю, а при включении обратно
 * не должно блокировать по устаревшему снимку.
 */
export async function syncHourBlocks(now: Date = new Date()): Promise<HourBlockDecision> {
  const settings = await getRiskSettings();
  const [hours, active] = await Promise.all([
    loadHourOutcomes(settings.tzOffsetMinutes),
    listActiveHourBlocks(),
  ]);

  const decision = decideHourBlocks(
    hours,
    active.map((row) => row.hour),
  );
  if (decision.toBlock.length > 0 || decision.toUnblock.length > 0) {
    await applyHourBlockDecision(decision, now);
  }
  return decision;
}

/** Заблокированные часы для UI: пустой список, когда правило выключено в админке. */
export async function listBlockedHours(): Promise<number[]> {
  const settings = await getRiskSettings();
  if (!settings.blockLosingHours) return [];
  const active = await listActiveHourBlocks();
  return active.map((row) => row.hour).sort((a, b) => a - b);
}

/**
 * Блокировка «сейчас убыточный час» или null. Дешёвый путь (часы не заблокированы или
 * текущий час открыт) не читает сделки вообще — статистика нужна только для текста
 * сообщения, то есть в редком случае, когда торговля и так закрыта.
 */
export async function evaluateLosingHourBlock(now: Date = new Date()): Promise<Block | null> {
  const settings = await getRiskSettings();
  if (!settings.blockLosingHours) return null;

  const active = await listActiveHourBlocks();
  if (active.length === 0) return null;

  const currentHour = getLocalHour(now, settings.tzOffsetMinutes);
  const currentBlock = active.find((row) => row.hour === currentHour);
  if (!currentBlock) return null;

  const blockedHours = active.map((row) => row.hour);
  const until = openHourAfter(now, blockedHours, settings.tzOffsetMinutes);
  if (!until) return null;

  const hours = await loadHourOutcomes(settings.tzOffsetMinutes);
  const profitableHour = nextProfitableHour(now, hours, settings.tzOffsetMinutes);
  const stat = hours.find((entry) => entry.hour === currentHour);
  const tpCount = stat?.tpCount ?? currentBlock.tpAtBlock;
  const total = stat?.total ?? currentBlock.tradesAtBlock;
  const winratePct = total > 0 ? Math.round((tpCount / total) * 100) : 0;

  const profitableHint =
    profitableHour !== null && profitableHour !== getLocalHour(until, settings.tzOffsetMinutes)
      ? `, ближайший прибыльный час — ${formatHour(profitableHour)}`
      : "";

  return {
    type: "losing_hour",
    reason:
      `${formatHour(currentHour)} — убыточный час: ${tpCount} из ${total} сделок в тейк (${winratePct}%). ` +
      `Торговля откроется в ${formatHour(getLocalHour(until, settings.tzOffsetMinutes))}${profitableHint}`,
    until,
  };
}

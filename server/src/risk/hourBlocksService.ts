import { applyHourBlockDecision, listActiveHourBlocks } from "../db/repositories/hourBlocks.js";
import { getRiskSettings } from "../db/repositories/settings.js";
import { listAllClosedTrades } from "../db/repositories/trades.js";
import { computeTradeInsights, toInsightInput } from "../history/insights.js";
import { resolveTradeOutcome } from "../history/outcome.js";
import {
  decideHourBlocks,
  formatHour,
  nextProfitableHour,
  openHourAfter,
  overallWinrate,
  type ClosedOutcome,
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

/**
 * Статистика закрытых сделок для правила: часы открытия (тот же расчёт, что у подсказки
 * в истории) и плоский список исходов со временем закрытия — по нему считается ОБЩИЙ
 * винрейт, в том числе «каким он был на момент блокировки часа» (см. hourBlocks.ts).
 */
async function loadTradeStats(
  tzOffsetMinutes: number,
): Promise<{ hours: HourOutcome[]; closed: ClosedOutcome[] }> {
  const rows = await listAllClosedTrades();
  const closed: ClosedOutcome[] = [];
  const inputs = rows.map((row) => {
    const input = toInsightInput(row);
    // Та же выборка, что и у часов: сделки без результата в статистику не идут.
    if (input.resultR !== null) {
      closed.push({
        closedAt: row.closedAt,
        isTp: resolveTradeOutcome(input, input.resultR) === "tp",
      });
    }
    return input;
  });
  return { hours: computeTradeInsights(inputs, tzOffsetMinutes).hourlyOutcomes, closed };
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
  const [{ hours, closed }, active] = await Promise.all([
    loadTradeStats(settings.tzOffsetMinutes),
    listActiveHourBlocks(),
  ]);

  const decision = decideHourBlocks({
    hours,
    // Винрейт на момент блокировки восстанавливаем по истории от blockedAt — отдельного
    // поля в БД для этого не нужно, и правило само чинится, если исход сделки поправили
    // вручную в админке.
    blocked: active.map((row) => ({
      hour: row.hour,
      overallWinrateAtBlock: overallWinrate(closed, row.blockedAt),
    })),
    overallWinrate: overallWinrate(closed),
  });
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

  const { hours } = await loadTradeStats(settings.tzOffsetMinutes);
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

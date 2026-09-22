import {
  applyHourBlockDecision,
  listActiveHourBlocks,
  markHourBlocksReviewed,
  unblockHours,
  type HourBlockRow,
} from "../db/repositories/hourBlocks.js";
import { getRiskSettings } from "../db/repositories/settings.js";
import { listAllClosedTrades, type Trade as TradeRow } from "../db/repositories/trades.js";
import { computeTradeInsights, toInsightInput } from "../history/insights.js";
import { computeMonthlyStats, toMonthlyStatInput } from "../history/monthlyStats.js";
import { resolveTradeOutcome } from "../history/outcome.js";
import {
  decideManualHourReview,
  MANUAL_HOUR_BLOCK_SOURCE,
  type MonthWinrate,
} from "./hourBlockReview.js";
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
): Promise<{ hours: HourOutcome[]; closed: ClosedOutcome[]; rows: TradeRow[] }> {
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
  return { hours: computeTradeInsights(inputs, tzOffsetMinutes).hourlyOutcomes, closed, rows };
}

/** Блокировка поставлена решением пользователя, а не расчётом правила. */
function isManualBlock(row: HourBlockRow): boolean {
  return row.source === MANUAL_HOUR_BLOCK_SOURCE;
}

/**
 * Винрейты по месяцам — ровно те, что показывает карточка месяца в «Статистике»
 * (`computeMonthlyStats`). Снимки эквити и корректировки не нужны: они влияют только на
 * «% к депозиту», а винрейт считается по одним сделкам.
 */
function monthWinrates(rows: TradeRow[], tzOffsetMinutes: number, now: Date): MonthWinrate[] {
  return computeMonthlyStats(rows.map(toMonthlyStatInput), tzOffsetMinutes, null, [], now, []).map(
    (month) => ({
      year: month.year,
      month: month.month,
      totalTrades: month.totalTrades,
      winRate: month.winRate,
    }),
  );
}

/**
 * Разовая проверка ручных блокировок по месячному винрейту (см. hourBlockReview.ts).
 * Ленивая и идемпотентная: запускается на тех же точках пересчёта, что и авто-правило,
 * поэтому отдельный крон не нужен — на границе месяца решение примет первое же закрытие
 * сделки, рестарт сервера или кнопка «Пересчитать».
 */
async function reviewManualHourBlocks(
  active: HourBlockRow[],
  rows: TradeRow[],
  tzOffsetMinutes: number,
  now: Date,
): Promise<number[]> {
  const pending = active.filter((row) => isManualBlock(row) && row.reviewedAt === null);
  if (pending.length === 0) return [];

  const decision = decideManualHourReview({
    blocks: pending.map((row) => ({
      hour: row.hour,
      baselineMonth: row.reviewBaselineMonth,
      fromMonth: row.reviewFromMonth,
      reviewed: false,
    })),
    months: monthWinrates(rows, tzOffsetMinutes, now),
    now,
    tzOffsetMinutes,
  });

  await unblockHours(decision.toUnblock, now);
  await markHourBlocksReviewed(decision.toMarkReviewed, now);
  return decision.toUnblock;
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
  const [{ hours, closed, rows }, active] = await Promise.all([
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
      manual: isManualBlock(row),
    })),
    overallWinrate: overallWinrate(closed),
  });
  if (decision.toBlock.length > 0 || decision.toUnblock.length > 0) {
    await applyHourBlockDecision(decision, now);
  }

  // Ручные блокировки автоматика выше не трогает — у них своя разовая проверка.
  const reviewUnblocked = await reviewManualHourBlocks(active, rows, settings.tzOffsetMinutes, now);
  if (reviewUnblocked.length === 0) return decision;

  const opened = new Set(reviewUnblocked);
  return {
    ...decision,
    toUnblock: [...decision.toUnblock, ...reviewUnblocked.map((hour) => ({ hour, reference: 0 }))],
    blockedHours: decision.blockedHours.filter((hour) => !opened.has(hour)),
  };
}

/**
 * Заблокированные часы для UI: и рассчитанные правилом, и закрытые вручную — в подсказке
 * у них один и тот же замок, различать их там не нужно (пояснение про ручные убрано
 * 23.09.2026 как лишнее). Пустой список, когда правило выключено в админке: тумблер гасит
 * механизм целиком, включая ручные блокировки (решение от 22.09.2026).
 */
export async function listBlockedHours(): Promise<number[]> {
  const settings = await getRiskSettings();
  if (!settings.blockLosingHours) return [];
  const active = await listActiveHourBlocks();
  return active.map((row) => row.hour).sort((a, b) => a - b);
}

/** Активные ручные блокировки для админки: час + состояние проверки. */
export async function listManualHourBlocks(): Promise<{ hour: number; reviewed: boolean }[]> {
  const active = await listActiveHourBlocks();
  return active
    .filter(isManualBlock)
    .map((row) => ({ hour: row.hour, reviewed: row.reviewedAt !== null }))
    .sort((a, b) => a.hour - b.hour);
}

/** Снять ручную блокировку часа из админки. Возвращает false, если такой блокировки нет. */
export async function releaseManualHourBlock(hour: number, now: Date = new Date()): Promise<boolean> {
  const active = await listActiveHourBlocks();
  const target = active.find((row) => row.hour === hour && isManualBlock(row));
  if (!target) return false;
  await unblockHours([hour], now);
  return true;
}

/**
 * Блокировка «сейчас убыточный час» или null. Дешёвый путь (часы не заблокированы или
 * текущий час открыт) не читает сделки вообще — статистика нужна только для текста
 * сообщения, то есть в редком случае, когда торговля и так закрыта.
 */
export async function evaluateLosingHourBlock(now: Date = new Date()): Promise<Block | null> {
  const settings = await getRiskSettings();
  if (!settings.blockLosingHours) return null;

  let active = await listActiveHourBlocks();
  if (active.length === 0) return null;

  const currentHour = getLocalHour(now, settings.tzOffsetMinutes);
  if (!active.some((row) => row.hour === currentHour)) return null;

  // Дальше нужна статистика сделок — и для текста, и (если час закрыт вручную и ждёт
  // проверки) для самой проверки. Читаем один раз.
  const { hours, rows } = await loadTradeStats(settings.tzOffsetMinutes);

  // Прогон проверки прямо здесь, а не только на закрытии сделки и старте сервера: иначе
  // после смены месяца час остался бы закрытым до первой закрытой сделки — а закрыть её
  // как раз и мешает этот час. Путь редкий (торговля и так заблокирована), поэтому
  // лишней работы на горячих запросах не появляется.
  if (active.some((row) => isManualBlock(row) && row.reviewedAt === null)) {
    const opened = await reviewManualHourBlocks(active, rows, settings.tzOffsetMinutes, now);
    if (opened.length > 0) {
      active = await listActiveHourBlocks();
      if (!active.some((row) => row.hour === currentHour)) return null;
    }
  }

  const currentBlock = active.find((row) => row.hour === currentHour);
  if (!currentBlock) return null;

  const blockedHours = active.map((row) => row.hour);
  const until = openHourAfter(now, blockedHours, settings.tzOffsetMinutes);
  if (!until) return null;

  const profitableHour = nextProfitableHour(now, hours, settings.tzOffsetMinutes);
  const stat = hours.find((entry) => entry.hour === currentHour);
  const tpCount = stat?.tpCount ?? currentBlock.tpAtBlock;
  const total = stat?.total ?? currentBlock.tradesAtBlock;
  const winratePct = total > 0 ? Math.round((tpCount / total) * 100) : 0;

  const profitableHint =
    profitableHour !== null && profitableHour !== getLocalHour(until, settings.tzOffsetMinutes)
      ? `, ближайший прибыльный час — ${formatHour(profitableHour)}`
      : "";
  const opensAt = `Торговля откроется в ${formatHour(getLocalHour(until, settings.tzOffsetMinutes))}${profitableHint}`;

  // У ручной блокировки статистика часа ничего не объясняет: час закрыт решением, а не
  // расчётом. Показывать «убыточный час: 4 из 5 в тейк» было бы прямой ложью.
  const reason = isManualBlock(currentBlock)
    ? currentBlock.reviewedAt !== null
      ? `${formatHour(currentHour)} — час закрыт: без него винрейт за месяц оказался выше. ${opensAt}`
      : `${formatHour(currentHour)} — час закрыт до проверки винрейта по итогам месяца. ${opensAt}`
    : `${formatHour(currentHour)} — убыточный час: ${tpCount} из ${total} сделок в тейк (${winratePct}%). ${opensAt}`;

  return { type: "losing_hour", reason, until };
}

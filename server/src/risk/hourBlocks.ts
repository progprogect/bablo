import { getLocalHour } from "./tradingDay.js";

/**
 * Правило «убыточные часы» (гипотеза пользователя от 12.09.2026): часы, в которых уже
 * накоплено достаточно статистики и винрейт совсем низкий, закрываются для открытия
 * сделок — цель поднять общий винрейт, не торгуя в заведомо слабое время.
 *
 * Три параметра правила:
 *
 * 1. ЭТАЛОН («достаточное количество сделок»). Берём максимум сделок среди ПРИБЫЛЬНЫХ
 *    часов — тех, у кого тейков не меньше половины (тот же порог, что у галочки в
 *    подсказке, см. client InsightPanel). Час считается изученным, только когда сделок
 *    в нём больше, чем у самого «нагруженного» прибыльного часа: пока час не отторговали
 *    хотя бы столько же, сравнивать не с чем.
 * 2. ПОРОГ БЛОКИРОВКИ — винрейт ≤ 30% включительно.
 * 3. ГИСТЕРЕЗИС РАЗБЛОКИРОВКИ — заблокированный час открывается снова, когда эталон
 *    вырос в 1.5 раза относительно количества сделок этого часа: статистика ушла далеко
 *    вперёд, и часу дают второй шанс. Именно из-за гистерезиса набор заблокированных
 *    часов — состояние в БД (таблица hour_blocks), а не чистая функция от статистики:
 *    между «уже не блокируется» и «ещё не разблокирован» час остаётся закрытым.
 */

/** Час прибыльный, если тейков не меньше половины (ровно 50% — тоже, как у галочки в подсказке). */
export const PROFITABLE_HOUR_SHARE = 0.5;

/** Час блокируется при винрейте не выше 30% (ровно 30% — тоже, по формулировке правила). */
export const LOSING_HOUR_SHARE = 0.3;

/** Во сколько раз эталон должен превзойти час, чтобы снять блокировку (+50%). */
export const UNBLOCK_REFERENCE_RATIO = 1.5;

/** Статистика часа открытия — ровно то, что отдаёт history/insights.ts. */
export type HourOutcome = { hour: number; tpCount: number; total: number };

export type HourBlockReason = {
  hour: number;
  tpCount: number;
  total: number;
  /** Эталон на момент блокировки — сколько сделок было у самого нагруженного прибыльного часа. */
  reference: number;
};

export type HourBlockDecision = {
  /** Часы, которые надо закрыть сейчас (их ещё нет среди заблокированных). */
  toBlock: HourBlockReason[];
  /** Часы, которые пора открыть: эталон вырос в UNBLOCK_REFERENCE_RATIO раз. */
  toUnblock: { hour: number; reference: number }[];
  /** Итоговый набор заблокированных часов после применения решения, по возрастанию. */
  blockedHours: number[];
  /** Эталон; null — прибыльных часов ещё нет, блокировать не с чем сравнивать. */
  reference: number | null;
};

function winrate(hour: HourOutcome): number {
  return hour.total > 0 ? hour.tpCount / hour.total : 0;
}

/**
 * Эталонное количество сделок: максимум по прибыльным часам. null — прибыльных часов
 * пока нет (или вообще нет статистики), тогда правило молчит.
 */
export function referenceTradeCount(hours: HourOutcome[]): number | null {
  let reference: number | null = null;
  for (const hour of hours) {
    if (hour.total <= 0 || winrate(hour) < PROFITABLE_HOUR_SHARE) continue;
    if (reference === null || hour.total > reference) {
      reference = hour.total;
    }
  }
  return reference;
}

/**
 * Решение по всем часам: кого закрыть, кого открыть, и итоговый набор. Чистая функция —
 * текущее состояние приходит параметром, применение (запись в БД) снаружи.
 */
export function decideHourBlocks(hours: HourOutcome[], currentlyBlocked: number[]): HourBlockDecision {
  const reference = referenceTradeCount(hours);
  const blocked = new Set(currentlyBlocked);
  const byHour = new Map(hours.map((entry) => [entry.hour, entry]));

  const toBlock: HourBlockReason[] = [];
  const toUnblock: { hour: number; reference: number }[] = [];

  if (reference !== null) {
    for (const hour of hours) {
      if (blocked.has(hour.hour)) continue;
      if (hour.total <= reference) continue; // ещё не изучен: сделок не больше, чем у эталона
      if (winrate(hour) > LOSING_HOUR_SHARE) continue;
      toBlock.push({ hour: hour.hour, tpCount: hour.tpCount, total: hour.total, reference });
      blocked.add(hour.hour);
    }
  }

  for (const hour of currentlyBlocked) {
    const stat = byHour.get(hour);
    // Часа не стало в статистике (сделки удалены/переразмечены) — держать блокировку не на чем.
    if (!stat || stat.total === 0) {
      toUnblock.push({ hour, reference: reference ?? 0 });
      blocked.delete(hour);
      continue;
    }
    if (reference !== null && reference >= stat.total * UNBLOCK_REFERENCE_RATIO) {
      toUnblock.push({ hour, reference });
      blocked.delete(hour);
    }
  }

  return {
    toBlock,
    toUnblock,
    blockedHours: [...blocked].sort((a, b) => a - b),
    reference,
  };
}

const HOURS_IN_DAY = 24;
const HOUR_MS = 3_600_000;

/** Начало следующего локального часа (в реальном UTC). */
function nextHourStart(now: Date, tzOffsetMinutes: number): Date {
  const shifted = now.getTime() + tzOffsetMinutes * 60_000;
  const startOfNext = Math.floor(shifted / HOUR_MS) * HOUR_MS + HOUR_MS;
  return new Date(startOfNext - tzOffsetMinutes * 60_000);
}

/**
 * Момент, когда закончится подряд идущая полоса заблокированных часов, начиная с текущего.
 * Если сейчас час не заблокирован — null.
 */
export function openHourAfter(now: Date, blockedHours: number[], tzOffsetMinutes: number): Date | null {
  const blocked = new Set(blockedHours);
  const currentHour = getLocalHour(now, tzOffsetMinutes);
  if (!blocked.has(currentHour)) return null;

  let until = nextHourStart(now, tzOffsetMinutes);
  // Подряд заблокированные часы схлопываем в одно ожидание: таймер должен показывать
  // время до реального открытия торговли, а не до следующей закрытой «полосы».
  for (let step = 1; step < HOURS_IN_DAY; step += 1) {
    if (!blocked.has((currentHour + step) % HOURS_IN_DAY)) break;
    until = new Date(until.getTime() + HOUR_MS);
  }
  return until;
}

/** Ближайший прибыльный час (винрейт ≥ 50%) начиная со следующего, или null. */
export function nextProfitableHour(
  now: Date,
  hours: HourOutcome[],
  tzOffsetMinutes: number,
): number | null {
  const profitable = new Set(
    hours.filter((hour) => hour.total > 0 && winrate(hour) >= PROFITABLE_HOUR_SHARE).map((h) => h.hour),
  );
  if (profitable.size === 0) return null;
  const currentHour = getLocalHour(now, tzOffsetMinutes);
  for (let step = 1; step <= HOURS_IN_DAY; step += 1) {
    const hour = (currentHour + step) % HOURS_IN_DAY;
    if (profitable.has(hour)) return hour;
  }
  return null;
}

export function formatHour(hour: number): string {
  return `${hour}:00`;
}

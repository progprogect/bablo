import type { Block } from "./limits.js";
import { getLocalHour } from "./tradingDay.js";

/**
 * Ручные блокировки торговли (запрос пользователя от 01.10.2026). Пришли на смену правилу
 * «убыточные часы» (жило 12.09–01.10.2026): никакой автоматики с эталонами и винрейтами —
 * пользователь сам решает, какие часы и какие промежутки времени закрыть, и на какой срок.
 *
 * Два вида блокировок:
 *
 * - ЧАС СУТОК на срок: пока срок не истёк, в этот час (таймзона риск-плана) каждый день
 *   нельзя открывать сделки. Час выбирается в настройках вместе со сроком (в днях).
 * - ОКНО на будущее: конкретная дата и время «с … до» (таймзона риск-плана) — в этом
 *   промежутке торговля закрыта целиком, независимо от часа.
 *
 * Главный инвариант: СНЯТЬ блокировку до истечения срока нельзя. Ни ручки в UI, ни
 * эндпоинта в API для этого нет — решение принимается заранее, в моменте его не
 * пересмотреть. Поэтому постановка блокировки проходит через подтверждение.
 *
 * Здесь только чистые функции без I/O (как limits.ts): состояние приходит параметром,
 * чтение БД и сборка ответа API — в manualBlocksService.ts.
 */

export type ManualHourBlock = { kind: "hour"; hour: number; endsAt: Date };
export type ManualWindowBlock = { kind: "window"; startsAt: Date; endsAt: Date };
export type ManualBlock = ManualHourBlock | ManualWindowBlock;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const HOURS_IN_DAY = 24;

/** Максимальный срок блокировки часа, в днях: защита от «закрыл на годы» опечаткой. */
export const MAX_HOUR_BLOCK_DAYS = 31;

/** Насколько далеко в будущее можно запланировать окно: дальше года — почти наверняка опечатка. */
export const MAX_WINDOW_AHEAD_MS = 366 * DAY_MS;

/** Начало следующего локального часа (в реальном UTC) — как в прежнем правиле часов. */
function nextHourStart(at: Date, tzOffsetMinutes: number): Date {
  const shifted = at.getTime() + tzOffsetMinutes * 60_000;
  const startOfNext = Math.floor(shifted / HOUR_MS) * HOUR_MS + HOUR_MS;
  return new Date(startOfNext - tzOffsetMinutes * 60_000);
}

/** Часы, закрытые ручной блокировкой в момент `now` (для замков в гистограмме подсказки). */
export function hoursBlockedAt(now: Date, blocks: ManualBlock[]): number[] {
  const hours = new Set<number>();
  for (const block of blocks) {
    if (block.kind === "hour" && block.endsAt.getTime() > now.getTime()) {
      hours.add(block.hour);
    }
  }
  return [...hours].sort((a, b) => a - b);
}

/**
 * Момент, до которого момент `at` остаётся заблокированным, или null — `at` свободен.
 * Несколько причин могут блокировать одновременно (час + окно): каждая покрывает отрезок
 * от `at` до своего «отпускания», поэтому их объединение непрерывно до максимума — его и
 * возвращаем, а вызывающий цикл проверяет новый момент заново (там может начаться другое
 * окно или другой закрытый час).
 */
function blockedUntilAt(at: Date, blocks: ManualBlock[], tzOffsetMinutes: number): Date | null {
  const atMs = at.getTime();
  const localHour = getLocalHour(at, tzOffsetMinutes);
  let releaseMs: number | null = null;

  for (const block of blocks) {
    if (block.endsAt.getTime() <= atMs) continue;
    if (block.kind === "hour") {
      if (block.hour !== localHour) continue;
      // Час отпускает на границе следующего часа или в момент истечения срока — что раньше.
      const release = Math.min(nextHourStart(at, tzOffsetMinutes).getTime(), block.endsAt.getTime());
      releaseMs = releaseMs === null ? release : Math.max(releaseMs, release);
    } else {
      if (block.startsAt.getTime() > atMs) continue; // окно ещё не началось
      releaseMs = releaseMs === null ? block.endsAt.getTime() : Math.max(releaseMs, block.endsAt.getTime());
    }
  }

  return releaseMs !== null ? new Date(releaseMs) : null;
}

/**
 * Момент, когда торговля откроется, если сейчас она закрыта ручной блокировкой; null —
 * сейчас открыто. Идём вперёд шагами «до отпускания текущей причины»: подряд закрытые
 * часы и примыкающие окна схлопываются в одно ожидание — таймер показывает время до
 * реального открытия. Цикл конечен: каждый шаг двигается минимум до границы часа или до
 * конца какого-то блока, а страховочный предел покрывает даже «закрыты все 24 часа».
 */
export function openMomentAfter(now: Date, blocks: ManualBlock[], tzOffsetMinutes: number): Date | null {
  let at = now;
  const maxSteps = HOURS_IN_DAY * (MAX_HOUR_BLOCK_DAYS + 2) + blocks.length + 8;
  for (let step = 0; step < maxSteps; step += 1) {
    const until = blockedUntilAt(at, blocks, tzOffsetMinutes);
    if (until === null) return step === 0 ? null : at;
    at = until;
  }
  return at;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** «14:00» / «2.10 в 14:00» — с датой, только если открытие не в текущие локальные сутки. */
export function formatOpenMoment(now: Date, until: Date, tzOffsetMinutes: number): string {
  const shiftedNow = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  const shiftedUntil = new Date(until.getTime() + tzOffsetMinutes * 60_000);
  const time = `${shiftedUntil.getUTCHours()}:${pad2(shiftedUntil.getUTCMinutes())}`;
  const sameDay =
    shiftedNow.getUTCFullYear() === shiftedUntil.getUTCFullYear() &&
    shiftedNow.getUTCMonth() === shiftedUntil.getUTCMonth() &&
    shiftedNow.getUTCDate() === shiftedUntil.getUTCDate();
  if (sameDay) return time;
  return `${shiftedUntil.getUTCDate()}.${pad2(shiftedUntil.getUTCMonth() + 1)} в ${time}`;
}

/**
 * Блокировка «сейчас действует ручная блокировка» для риск-гейта и дашборда, или null.
 * Текст объясняет, ЧТО закрыло торговлю: конкретный час — своей строкой (час главнее
 * окна: он конкретнее), иначе — окно.
 */
export function describeManualBlock(
  now: Date,
  blocks: ManualBlock[],
  tzOffsetMinutes: number,
): Block | null {
  const until = openMomentAfter(now, blocks, tzOffsetMinutes);
  if (until === null) return null;

  const currentHour = getLocalHour(now, tzOffsetMinutes);
  const hourIsBlocked = blocks.some(
    (block) => block.kind === "hour" && block.hour === currentHour && block.endsAt.getTime() > now.getTime(),
  );
  const opensAt = `Торговля откроется в ${formatOpenMoment(now, until, tzOffsetMinutes)}`;
  const reason = hourIsBlocked
    ? `${currentHour}:00 — час закрыт вручную. ${opensAt}`
    : `Торговля закрыта вручную по расписанию. ${opensAt}`;

  return { type: "manual_block", reason, until };
}

export type HourBlockInput = { hour: number; days: number };

/**
 * Проверка заявки «закрыть час на N дней». Возвращает текст ошибки или null.
 * `activeHours` — часы, уже закрытые на момент постановки: двойная блокировка часа
 * запрещена, иначе «продлить» можно было бы бесконечно, а снять — никогда.
 */
export function validateHourBlockInput(input: HourBlockInput, activeHours: number[]): string | null {
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) {
    return "Час должен быть целым числом от 0 до 23";
  }
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_HOUR_BLOCK_DAYS) {
    return `Срок должен быть от 1 до ${MAX_HOUR_BLOCK_DAYS} дней`;
  }
  if (activeHours.includes(input.hour)) {
    return `${input.hour}:00 уже закрыт — продлить или снять блокировку до истечения срока нельзя`;
  }
  return null;
}

export type WindowInput = { date: string; from: string; to: string };

/** «YYYY-MM-DD» → миллисекунды полуночи этой локальной даты по UTC-шкале, или null. */
function parseLocalDateMs(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  // Date.parse прощает «2026-02-31» (перенос в март) — круговая проверка это ловит.
  return new Date(ms).toISOString().slice(0, 10) === date ? ms : null;
}

/** «HH:MM» → минуты от полуночи, или null. 24:00 допустимо как конец окна. */
function parseTimeMinutes(time: string, allowMidnightEnd: boolean): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  if (hours > 23) {
    if (allowMidnightEnd && hours === 24 && minutes === 0) return 24 * 60;
    return null;
  }
  return hours * 60 + minutes;
}

/**
 * Собирает окно блокировки из локальных (таймзона риск-плана) даты и времени «с … до».
 * Ошибка — текстом, чтобы API отдал её пользователю как есть. Окно, начавшееся в прошлом,
 * но ещё не закончившееся, допустимо — оно просто действует сразу.
 */
export function buildWindow(
  input: WindowInput,
  now: Date,
  tzOffsetMinutes: number,
): { startsAt: Date; endsAt: Date } | { error: string } {
  const dayMs = parseLocalDateMs(input.date);
  if (dayMs === null) return { error: "Дата должна быть в формате ГГГГ-ММ-ДД" };
  const fromMinutes = parseTimeMinutes(input.from, false);
  if (fromMinutes === null) return { error: "Время «с» должно быть в формате ЧЧ:ММ" };
  const toMinutes = parseTimeMinutes(input.to, true);
  if (toMinutes === null) return { error: "Время «до» должно быть в формате ЧЧ:ММ" };
  if (toMinutes <= fromMinutes) return { error: "Время «до» должно быть позже времени «с»" };

  const startsAt = new Date(dayMs + fromMinutes * 60_000 - tzOffsetMinutes * 60_000);
  const endsAt = new Date(dayMs + toMinutes * 60_000 - tzOffsetMinutes * 60_000);
  if (endsAt.getTime() <= now.getTime()) {
    return { error: "Это время уже прошло — блокировать нечего" };
  }
  if (startsAt.getTime() > now.getTime() + MAX_WINDOW_AHEAD_MS) {
    return { error: "Слишком далёкая дата — проверь год" };
  }
  return { startsAt, endsAt };
}

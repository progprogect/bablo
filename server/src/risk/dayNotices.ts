import { singleResultWeekdayName } from "./limits.js";
import { getTradingDayKey } from "./tradingDay.js";

/**
 * Уведомления на главном экране (просьба пользователя от 25.10.2026): то, что нужно знать
 * ДО входа в сделку и именно сегодня. Висят весь торговый день, скрыть их нельзя — это не
 * оповещение «посмотрел и закрыл», а условие дня.
 *
 * Два повода:
 *
 * - ЧАС ОТКРЫВАЕТСЯ. Закрытый вручную час (risk/manualBlocks.ts) снимается молча, по
 *   истечении срока — легко не заметить, что торговля в нём снова разрешена. Уведомление
 *   показывается дважды: в последний день блокировки («завтра час снова открыт») и в
 *   первый день после неё («открыт с сегодня»). Второй показ нужен, потому что продлить
 *   блокировку можно ТОЛЬКО после её истечения — раньше validateHourBlockInput откажет.
 * - ПН И ПТ. В эти дни день закрывает одна закрытая сделка — хоть стоп, хоть тейк
 *   (правило #16, limits.ts): напоминание выбирать вход придирчивее, пока единственная
 *   попытка ещё не потрачена.
 *
 * Сутки здесь — ТОРГОВЫЙ день (сброс в resetHour, а не в полночь): уведомление живёт
 * ровно столько же, сколько дневные лимиты, к которым относится.
 *
 * Здесь только чистые функции без I/O (как limits.ts): блокировки приходят параметром,
 * чтение БД — в dayNoticesService.ts.
 */

export type DayNotice = {
  /** Стабильный ключ: "weekday" или "hour-open:<час>". */
  id: string;
  /** "warn" — осторожность (день недели), "info" — изменение условий (час открывается). */
  tone: "warn" | "info";
  title: string;
  detail: string;
};

/** Час, закрытый вручную: нужны только час суток и момент окончания срока. */
export type HourBlockForNotice = { hour: number; endsAt: Date };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Насколько глубоко в прошлое нужны уже истёкшие блокировки: уведомление «открыт с
 * сегодня» показывается весь первый свободный торговый день, а он заканчивается почти
 * через двое суток после самого раннего возможного истечения срока. Четверо суток —
 * тот же запас ещё раз.
 */
export const NOTICE_HISTORY_MS = 4 * DAY_MS;

/** Последнее начало локального часа `hour`, которое ещё попало под блокировку до `endsAt`. */
function lastBlockedSlotStart(hour: number, endsAt: Date, tzOffsetMinutes: number): Date {
  const shiftedEnd = new Date(endsAt.getTime() + tzOffsetMinutes * 60_000);
  const slot = new Date(
    Date.UTC(shiftedEnd.getUTCFullYear(), shiftedEnd.getUTCMonth(), shiftedEnd.getUTCDate(), hour),
  );
  // Срок истёк раньше, чем начался сегодняшний такой час, — последним был вчерашний.
  if (slot.getTime() >= shiftedEnd.getTime()) slot.setUTCDate(slot.getUTCDate() - 1);
  return new Date(slot.getTime() - tzOffsetMinutes * 60_000);
}

/** Следующий день за ключом дня (YYYY-MM-DD); null — ключ не разобрать. */
function nextDayKey(dayKey: string): string | null {
  const ms = Date.parse(`${dayKey}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + DAY_MS).toISOString().slice(0, 10);
}

/** «2026-10-26» → «26.10». */
function formatDayKey(dayKey: string): string {
  const [, month, day] = dayKey.split("-");
  return `${Number(day)}.${month}`;
}

/**
 * Реальный момент открытия каждого часа: если час закрывали несколько раз, срок задаёт
 * последняя по времени блокировка. Иначе истёкшая первой подняла бы уведомление
 * «час снова открыт» поверх ещё действующей.
 */
function latestEndByHour(blocks: HourBlockForNotice[]): Map<number, Date> {
  const byHour = new Map<number, Date>();
  for (const block of blocks) {
    const known = byHour.get(block.hour);
    if (!known || block.endsAt.getTime() > known.getTime()) byHour.set(block.hour, block.endsAt);
  }
  return byHour;
}

export type DayNoticesInput = {
  now: Date;
  resetHour: number;
  tzOffsetMinutes: number;
  /** Закрытые часы — действующие и истёкшие не раньше чем NOTICE_HISTORY_MS назад. */
  hourBlocks: HourBlockForNotice[];
};

/** Уведомления сегодняшнего торгового дня: сначала про день недели, потом по часам. */
export function buildDayNotices(input: DayNoticesInput): DayNotice[] {
  const todayKey = getTradingDayKey(input.now, input.resetHour, input.tzOffsetMinutes);
  const notices: DayNotice[] = [];

  const weekday = singleResultWeekdayName(todayKey);
  if (weekday !== null) {
    notices.push({
      id: "weekday",
      tone: "warn",
      title: `Сегодня ${weekday}`,
      detail: "Стоп или тейк — и день закрыт. Выбирай вход придирчивее",
    });
  }

  for (const [hour, endsAt] of [...latestEndByHour(input.hourBlocks)].sort((a, b) => a[0] - b[0])) {
    const lastDayKey = getTradingDayKey(
      lastBlockedSlotStart(hour, endsAt, input.tzOffsetMinutes),
      input.resetHour,
      input.tzOffsetMinutes,
    );
    const freeDayKey = nextDayKey(lastDayKey);
    if (freeDayKey === null) continue;

    const id = `hour-open:${hour}`;
    const hourLabel = `${hour}:00`;
    if (todayKey === lastDayKey) {
      notices.push({
        id,
        tone: "info",
        title: `${hourLabel} закрыт последний день`,
        detail: `С ${formatDayKey(freeDayKey)} торговать в ${hourLabel} снова можно. Продли блокировку, если нужно`,
      });
    } else if (todayKey === freeDayKey) {
      notices.push({
        id,
        tone: "info",
        title: `${hourLabel} снова открыт`,
        detail: `Блокировка закончилась — с сегодня, ${formatDayKey(freeDayKey)}, торговать в ${hourLabel} можно. Продли, если нужно`,
      });
    }
  }

  return notices;
}

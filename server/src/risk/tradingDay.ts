/**
 * Торговый день сбрасывается не в полночь UTC, а в настраиваемый час локальной
 * таймзоны (по умолчанию 07:00 UTC+3, см. docs/RISK_ENGINE.md). Вся арифметика
 * ведётся в "смещённой" временной шкале: реальный момент времени сдвигается на
 * tzOffsetMinutes, после чего его UTC-компоненты дают корректные локальные
 * часы/дату без использования внешних библиотек часовых поясов.
 */
function toShifted(date: Date, tzOffsetMinutes: number): Date {
  return new Date(date.getTime() + tzOffsetMinutes * 60_000);
}

function fromShifted(date: Date, tzOffsetMinutes: number): Date {
  return new Date(date.getTime() - tzOffsetMinutes * 60_000);
}

/** Ключ торгового дня (YYYY-MM-DD в локальной таймзоне) для группировки daily_stats. */
export function getTradingDayKey(date: Date, resetHour: number, tzOffsetMinutes: number): string {
  const shifted = toShifted(date, tzOffsetMinutes);
  const dayStart = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()),
  );
  if (shifted.getUTCHours() < resetHour) {
    dayStart.setUTCDate(dayStart.getUTCDate() - 1);
  }
  const iso = dayStart.toISOString();
  const datePart = iso.slice(0, 10);
  return datePart;
}

/** Час дня (0–23) в настроенной локальной таймзоне — используется для группировки по времени дня (см. history/insights.ts). */
export function getLocalHour(date: Date, tzOffsetMinutes: number): number {
  return toShifted(date, tzOffsetMinutes).getUTCHours();
}

/**
 * Обычный календарный день (YYYY-MM-DD) в локальной таймзоне — в отличие от
 * getTradingDayKey, сбрасывается в полночь, а не в настраиваемый час риск-плана.
 * Используется там, где нужен именно календарный день: месячная статистика,
 * снимки эквити (см. history/monthlyStats.ts, db/repositories/equitySnapshots.ts).
 */
export function getLocalDateKey(date: Date, tzOffsetMinutes: number): string {
  return getTradingDayKey(date, 0, tzOffsetMinutes);
}

/** Следующий момент сброса дня (в реальном UTC) строго после `date`. */
export function getNextResetAt(date: Date, resetHour: number, tzOffsetMinutes: number): Date {
  const shifted = toShifted(date, tzOffsetMinutes);
  const candidate = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), resetHour, 0, 0, 0),
  );
  if (candidate <= shifted) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return fromShifted(candidate, tzOffsetMinutes);
}

/**
 * Момент сброса, до которого торговля закрыта, если день `dayKey` закрыт лестницей пауз
 * (risk/stopChain.ts) плюс `extraFullDays` ПОЛНЫХ дней сверху. День `dayKey` заканчивается
 * сбросом следующих суток, каждый полный день добавляет ещё сутки.
 *
 * `dayKey` — ключ торгового дня (YYYY-MM-DD, как его отдаёт getTradingDayKey). Некорректный
 * ключ даёт null: риск-движок в этом случае просто не ставит блокировку, а не падает
 * посреди записи результата закрытой сделки.
 */
export function getResetAtAfterTradingDay(
  dayKey: string,
  extraFullDays: number,
  resetHour: number,
  tzOffsetMinutes: number,
): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const extra = Number.isFinite(extraFullDays) ? Math.max(0, Math.trunc(extraFullDays)) : 0;
  const shifted = new Date(Date.UTC(year, month - 1, day + 1 + extra, resetHour, 0, 0, 0));
  if (Number.isNaN(shifted.getTime())) return null;
  return fromShifted(shifted, tzOffsetMinutes);
}

/**
 * Начало «ночи» в локальных часах (по умолчанию 00:00 МСК). Ночь длится до
 * resetHour торгового дня (07:00): в это окно дневные сделки поджимают TP до 1/1
 * (см. trades/nightTp.ts, docs/PROJECT.md).
 */
export const DEFAULT_NIGHT_START_HOUR = 0;

/**
 * Локальный час попадает в ночное окно [nightStartHour, resetHour).
 * Если nightStart ≥ reset (например 23→7) — окно через полночь: hour ≥ nightStart ИЛИ hour < reset.
 */
export function isLocalNight(
  date: Date,
  nightStartHour: number,
  resetHour: number,
  tzOffsetMinutes: number,
): boolean {
  const hour = getLocalHour(date, tzOffsetMinutes);
  if (nightStartHour < resetHour) {
    return hour >= nightStartHour && hour < resetHour;
  }
  return hour >= nightStartHour || hour < resetHour;
}

/** Момент начала текущей (или только что начавшейся) ночи — в реальном UTC. */
export function getNightStartAtOrBefore(
  date: Date,
  nightStartHour: number,
  tzOffsetMinutes: number,
): Date {
  const shifted = toShifted(date, tzOffsetMinutes);
  const candidate = new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
      nightStartHour,
      0,
      0,
      0,
    ),
  );
  if (candidate > shifted) {
    candidate.setUTCDate(candidate.getUTCDate() - 1);
  }
  return fromShifted(candidate, tzOffsetMinutes);
}

/** Следующее начало ночи строго после `date` (для одноразового таймера, без поллинга). */
export function getNextNightStartAt(
  date: Date,
  nightStartHour: number,
  tzOffsetMinutes: number,
): Date {
  const shifted = toShifted(date, tzOffsetMinutes);
  const candidate = new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
      nightStartHour,
      0,
      0,
      0,
    ),
  );
  if (candidate <= shifted) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return fromShifted(candidate, tzOffsetMinutes);
}

/**
 * Сделка открыта утром/днём/вечером (не ночью) и сейчас уже ночь —
 * кандидат на поджатие TP до 1/1.
 */
export function isDayTradeIntoNight(
  openedAt: Date,
  now: Date,
  nightStartHour: number,
  resetHour: number,
  tzOffsetMinutes: number,
): boolean {
  if (!isLocalNight(now, nightStartHour, resetHour, tzOffsetMinutes)) return false;
  if (isLocalNight(openedAt, nightStartHour, resetHour, tzOffsetMinutes)) return false;
  const nightStart = getNightStartAtOrBefore(now, nightStartHour, tzOffsetMinutes);
  return openedAt.getTime() < nightStart.getTime();
}

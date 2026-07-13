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

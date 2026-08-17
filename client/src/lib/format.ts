/** Цена/сумма с фиксированным количеством знаков — "—" для отсутствующих значений. */
export function formatPrice(value: string | number | null | undefined, digits = 4): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

/**
 * Убирает незначащие нули после округления: 2.00 → "2", 1.50 → "1.5", 1.33 → "1.33".
 * Используется для соотношения риск/прибыль, где целые значения не должны выглядеть
 * как "1 / 2.00".
 */
export function trimTrailingZeros(value: number, maxDecimals = 2): string {
  return Number(value.toFixed(maxDecimals)).toString();
}

/**
 * R показывается с точностью до десятых. Само правило живёт на сервере
 * (`history/outcome.ts#roundStatsR`) и применяется ДО агрегации, поэтому сумма R в
 * карточке месяца сходится со суммой R по карточкам сделок. Здесь округление —
 * страховка от накопленного float-шума при сложении (1.9000000000000001 → 1.9)
 * и единая точка форматирования для Истории и Статистики.
 *
 * Деньги (USDT, % к депозиту) не округляются: там нужна фактическая точность, иначе
 * восстановление эквити прошлых месяцев разойдётся с балансом на бирже.
 */
export function roundR(value: number): number {
  return Math.round(value * 10) / 10;
}

/** R сделки в виде соотношения, как принято в карточках: 1.12 → "1/1.1", 2 → "1/2". */
export function formatRatioR(value: number): string {
  return `1/${trimTrailingZeros(roundR(Math.abs(value)), 1)}`;
}

/** Знаковое число R без суффикса: 4.04 → "+4", −1.36 → "-1.4". Для пар вида «+R / −R». */
export function formatSignedRValue(value: number): string {
  const rounded = roundR(value);
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${trimTrailingZeros(rounded, 1)}`;
}

/** Сумма R со знаком для отчётов: 4.04 → "+4R", −1.36 → "-1.4R". */
export function formatSignedR(value: number): string {
  return `${formatSignedRValue(value)}R`;
}

/** "+12.30 USDT" / "-4.50 USDT" — со знаком, для наглядности прибыли/убытка. */
export function formatSignedUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatPrice(value, 2)} USDT`;
}

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

/** "+12.30 USDT" / "-4.50 USDT" — со знаком, для наглядности прибыли/убытка. */
export function formatSignedUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatPrice(value, 2)} USDT`;
}

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

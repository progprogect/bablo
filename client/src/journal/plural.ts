/** Русские формы по числу: plural(3, "сделка", "сделки", "сделок") → "3 сделки". */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  const word = abs > 10 && abs < 20 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many;
  return `${n} ${word}`;
}

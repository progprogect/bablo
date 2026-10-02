/**
 * Замок «торговля закрыта» — один значок на всё приложение: гистограмма часов в подсказке
 * «Сделок» (правило #10) и карточка правил блокировки в «Настройках». Геометрия та же,
 * что была локально в InsightPanel: кружок, дужка и корпус.
 */
export function BlockedMark({ label = "торговля закрыта" }: { label?: string }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-label={label}>
      <circle cx="8" cy="8" r="8" className="fill-slate-200" />
      <path
        d="M6 7.2V5.9a2 2 0 0 1 4 0V7.2"
        className="stroke-slate-500"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
      <rect x="4.9" y="7.2" width="6.2" height="4.6" rx="1.3" className="fill-slate-500" />
    </svg>
  );
}

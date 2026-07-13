/**
 * Компактный индикатор уровня риск-плана на дашборде — тап открывает полное дерево
 * роста (RiskTreeSheet). `justLeveledUp` на короткое время добавляет свечение/лёгкий
 * "поп" эффект через CSS-переходы — визуальная реакция на переход уровня (Этап 6).
 */
export function LevelIndicator({
  currentLevel,
  accumulatedR,
  requiredR,
  justLeveledUp,
  onOpen,
}: {
  currentLevel: number;
  accumulatedR: number;
  requiredR: number | null;
  justLeveledUp: boolean;
  onOpen: () => void;
}) {
  const progressPct = requiredR && requiredR > 0 ? Math.min(100, (accumulatedR / requiredR) * 100) : 100;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`mx-4 flex items-center gap-3 rounded-2xl border bg-card px-4 py-2.5 text-left shadow-sm transition-all duration-500 ${
        justLeveledUp
          ? "scale-[1.03] border-accent shadow-[0_0_18px_rgba(47,111,237,0.35)]"
          : "scale-100 border-line"
      }`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent">
        {currentLevel}
      </span>
      <span className="flex flex-1 flex-col gap-1.5">
        <span className="flex items-center justify-between text-xs text-slate-500">
          <span>Уровень {currentLevel}</span>
          <span>{requiredR !== null ? `${accumulatedR.toFixed(1)}R / ${requiredR}R` : "макс. уровень"}</span>
        </span>
        <span className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
          <span
            className="block h-full rounded-full bg-accent transition-all duration-700"
            style={{ width: `${progressPct}%` }}
          />
        </span>
      </span>
    </button>
  );
}

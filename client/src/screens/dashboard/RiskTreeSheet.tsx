import { useEffect, useRef, useState, type RefObject } from "react";
import { getRiskTreeLevels } from "../../api/client";
import type { RiskLevel } from "../../api/types";

/**
 * Полноэкранный шит «Дерево роста» (Этап 6, docs/RISK_ENGINE.md): вертикальный путь
 * уровней — пройденные отмечены галочкой, текущий подсвечен с прогресс-баром, будущие
 * приглушены. Осознанно без SVG-графики дерева/веток — по принципу минимализма
 * (docs/PROJECT.md: «никаких графиков») путь узлов передаёт ту же идею роста проще.
 */
export function RiskTreeSheet({
  currentLevel,
  accumulatedR,
  onClose,
}: {
  currentLevel: number;
  accumulatedR: number;
  onClose: () => void;
}) {
  const [levels, setLevels] = useState<RiskLevel[] | null>(null);
  const currentNodeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    getRiskTreeLevels()
      .then(setLevels)
      .catch(() => setLevels([]));
  }, []);

  useEffect(() => {
    currentNodeRef.current?.scrollIntoView({ block: "center" });
  }, [levels]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-surface">
      <div
        className="flex items-center justify-between border-b border-slate-800 px-4 pb-3"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 16px)" }}
      >
        <h2 className="text-base font-medium text-slate-100">Дерево роста</h2>
        <button type="button" onClick={onClose} className="text-sm text-slate-400">
          Закрыть
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {levels === null ? (
          <p className="text-center text-sm text-slate-500">Загрузка…</p>
        ) : (
          <div className="flex flex-col gap-2 pb-6">
            {levels.map((level) => (
              <LevelNode
                key={level.level}
                level={level}
                currentLevel={currentLevel}
                accumulatedR={accumulatedR}
                nodeRef={level.level === currentLevel ? currentNodeRef : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LevelNode({
  level,
  currentLevel,
  accumulatedR,
  nodeRef,
}: {
  level: RiskLevel;
  currentLevel: number;
  accumulatedR: number;
  nodeRef?: RefObject<HTMLDivElement | null>;
}) {
  const isPast = level.level < currentLevel;
  const isCurrent = level.level === currentLevel;
  const requiredR = Number(level.requiredR);
  const progressPct = isCurrent && requiredR > 0 ? Math.min(100, (accumulatedR / requiredR) * 100) : isPast ? 100 : 0;

  return (
    <div
      ref={nodeRef}
      className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors duration-700 ${
        isCurrent
          ? "border-accent bg-accent/10"
          : isPast
            ? "border-emerald-500/30 bg-emerald-500/5"
            : "border-slate-800/60"
      }`}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors duration-700 ${
          isCurrent ? "bg-accent text-surface" : isPast ? "bg-emerald-500/20 text-emerald-400" : "bg-slate-800 text-slate-500"
        }`}
      >
        {isPast ? "✓" : level.level}
      </span>

      <div className="flex flex-1 flex-col gap-1">
        <div className="flex items-center justify-between text-sm">
          <span className={isPast || isCurrent ? "text-slate-100" : "text-slate-500"}>
            {Number(level.riskUsd)} USDT
          </span>
          <span className="text-xs text-slate-500">
            {isCurrent ? `${accumulatedR.toFixed(1)}R / ${requiredR}R` : `+${requiredR}R`}
          </span>
        </div>
        {(isCurrent || isPast) && (
          <span className="h-1 w-full overflow-hidden rounded-full bg-slate-800">
            <span
              className="block h-full rounded-full bg-accent transition-all duration-700"
              style={{ width: `${progressPct}%` }}
            />
          </span>
        )}
      </div>
    </div>
  );
}

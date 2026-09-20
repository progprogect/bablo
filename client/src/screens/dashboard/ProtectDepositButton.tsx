import { useEffect, useState } from "react";
import { ApiError, pauseTradingRequest } from "../../api/client";

/** Сколько ждём подтверждения, прежде чем вернуть кнопку в спокойное состояние. */
const CONFIRM_TIMEOUT_MS = 5_000;

function ShieldIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true">
      <path
        d="M10 2.5 4 4.8v4.4c0 3.4 2.4 6.5 6 8.3 3.6-1.8 6-4.9 6-8.3V4.8L10 2.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M7.6 9.9 9.3 11.6 12.6 8.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Кнопка под формой открытия сделки: «Поберечь депозит до лучшего входа» — ставит
 * добровольную паузу на 2 часа (docs/RISK_ENGINE.md, правило #13). Заменила поп-ап про
 * состояние (20.09.2026): вместо вопроса, который приложение задаёт само и на который
 * отвечаешь на автомате, — действие в тот момент, когда сомнение реально возникло.
 *
 * Нажатие двухшаговое: первый тап превращает кнопку в «Точно? Пауза 2 часа», второй
 * подтверждает. Это дешевле нативного confirm и защищает от случайного тапа, который
 * стоил бы двух часов торговли.
 */
export function ProtectDepositButton({ onPaused }: { onPaused: () => void }) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isConfirming) return;
    const timer = setTimeout(() => setIsConfirming(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isConfirming]);

  async function handleClick() {
    if (!isConfirming) {
      setError(null);
      setIsConfirming(true);
      return;
    }
    setIsSaving(true);
    try {
      await pauseTradingRequest();
      onPaused();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось поставить паузу");
      setIsConfirming(false);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="mx-4 flex flex-col gap-1.5">
      <button
        type="button"
        disabled={isSaving}
        onClick={handleClick}
        className={`flex w-full items-center justify-center gap-2 rounded-xl border py-3 text-sm font-medium transition active:scale-[0.98] disabled:opacity-50 ${
          isConfirming
            ? "border-amber-300 bg-amber-50 text-amber-800"
            : "border-line bg-card text-slate-600 shadow-sm"
        }`}
      >
        <ShieldIcon className="h-4 w-4" />
        {isSaving
          ? "Ставлю паузу…"
          : isConfirming
            ? "Точно? Пауза на 2 часа"
            : "Поберечь депозит до лучшего входа"}
      </button>
      <p className="text-center text-[11px] text-slate-400">
        {isConfirming
          ? "Нажми ещё раз — и берём паузу на 2 часа"
          : "Сомнение — тоже сигнал. Дай себе 2 часа тишины"}
      </p>
      {error && <p className="text-center text-xs text-red-600">{error}</p>}
    </div>
  );
}

import { useState } from "react";
import { ApiError, pauseTradingRequest } from "../../api/client";

/**
 * Кнопка под формой открытия сделки: ставит добровольную паузу на 2 часа
 * (docs/RISK_ENGINE.md, правило #13). Заменила поп-ап про состояние (20.09.2026): вместо
 * вопроса, который приложение задаёт само, — действие ровно там, где возникает сомнение.
 *
 * Одно нажатие, без подтверждения (просьба пользователя от 20.09.2026): пауза — это
 * забота о себе, а не опасное действие, и лишний шаг тут только мешает.
 */
export function ProtectDepositButton({ onPaused }: { onPaused: () => void }) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (isSaving) return;
    setError(null);
    setIsSaving(true);
    try {
      await pauseTradingRequest();
      onPaused();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось поставить паузу");
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
        className="flex w-full items-center gap-3 rounded-2xl border border-line bg-card p-3.5 text-left shadow-sm transition active:scale-[0.99] disabled:opacity-60"
      >
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface text-2xl leading-none"
          aria-hidden="true"
        >
          🛟
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-ink">Поберечь депозит</span>
          <span className="text-[11px] leading-snug text-slate-500">
            {isSaving ? "Беру паузу…" : "Сомнение — тоже сигнал. Дай себе 2 часа тишины"}
          </span>
        </span>
      </button>
      {error && <p className="text-center text-xs text-red-600">{error}</p>}
    </div>
  );
}

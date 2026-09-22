import { useState } from "react";
import { ApiError, pauseTradingRequest } from "../../api/client";

/**
 * Кнопка под формой открытия сделки: ставит добровольную паузу на 2 часа
 * (docs/RISK_ENGINE.md, правило #13). Заменила поп-ап про состояние (20.09.2026): вместо
 * вопроса, который приложение задаёт само, — действие ровно там, где возникает сомнение.
 *
 * Одно нажатие, без подтверждения (просьба пользователя от 20.09.2026): пауза — это
 * забота о себе, а не опасное действие, и лишний шаг тут только мешает.
 *
 * Геометрия карточки повторяет LevelIndicator (просьба от 22.09.2026 — единая стилистика
 * дашборда): те же px-4 py-2.5, тот же кружок иконки h-9 w-9 и gap-3.
 *
 * Высота всё же на ~13px больше уровня, и это осознанно. Высоту держит не иконка (36px),
 * а подпись: «Сомнение — тоже сигнал. Дай себе 2 часа тишины» требует 281px при доступных
 * 257px, поэтому переносится на вторую строку. Ровно 58px, как у уровня, получается
 * только если подпись влезает в одну строку — то есть если её сократить (пользователь
 * 22.09.2026 отказался) или увести на 10px (влезает с запасом −1px, то есть на реальном
 * Safari скорее всего снова перенесётся). Сокращаешь подпись — карточка сама сядет в 58px.
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
        className="flex w-full items-center gap-3 rounded-2xl border border-line bg-card px-4 py-2.5 text-left shadow-sm transition active:scale-[0.99] disabled:opacity-60"
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface text-xl leading-none"
          aria-hidden="true"
        >
          🛟
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-ink">Поберечь депозит</span>
          <span className="text-[11px] leading-tight text-slate-500">
            {isSaving ? "Беру паузу…" : "Сомнение — тоже сигнал. Дай себе 2 часа тишины"}
          </span>
        </span>
      </button>
      {error && <p className="text-center text-xs text-red-600">{error}</p>}
    </div>
  );
}

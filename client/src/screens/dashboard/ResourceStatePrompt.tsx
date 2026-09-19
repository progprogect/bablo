import { useState } from "react";
import { ApiError, setResourceStateRequest } from "../../api/client";
import type { ResourceState } from "../../api/types";

/**
 * Поп-ап про состояние перед входом в рынок. Показывается на «точках пересборки» (см.
 * сервер, risk/resourceState.ts): начало торгового дня и конец часового перерыва после
 * закрытой сделки — то есть ровно тогда, когда снова можно входить. Ответ хранится на
 * сервере, поэтому на каждую точку спрашивают один раз, с любого устройства.
 *
 * Формулировка намеренно не про «ресурсное состояние» (клише, на которое отвечаешь
 * автоматически), а про ощущения здесь и сейчас — просьба пользователя от 19.09.2026.
 * Выбор из двух настроений: спокойное состояние пропускает к торговле, тревожное ставит
 * паузу на 2 часа (docs/RISK_ENGINE.md, правило #13) — и об этом честно написано прямо
 * на кнопке, чтобы выбор был осознанным, а не сюрпризом.
 */
function MoodButton({
  emoji,
  label,
  caption,
  tone,
  disabled,
  onClick,
}: {
  emoji: string;
  label: string;
  caption: string;
  tone: "calm" | "storm";
  disabled: boolean;
  onClick: () => void;
}) {
  const toneClass =
    tone === "calm"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : "border-amber-200 bg-amber-50 text-amber-900";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex flex-col items-center gap-1 rounded-2xl border px-3 py-4 transition active:scale-95 disabled:opacity-50 ${toneClass}`}
    >
      <span className="text-3xl leading-none" aria-hidden="true">
        {emoji}
      </span>
      <span className="mt-1 text-sm font-medium leading-tight">{label}</span>
      <span className="text-[11px] leading-tight opacity-75">{caption}</span>
    </button>
  );
}

export function ResourceStatePrompt({
  askReason,
  onAnswered,
}: {
  askReason: "day" | "cooldown" | null | undefined;
  onAnswered: (state: ResourceState) => void;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(isResourceful: boolean) {
    setError(null);
    setIsSaving(true);
    try {
      onAnswered(await setResourceStateRequest(isResourceful));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить ответ");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-6">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-line bg-card p-5 shadow-lg">
        <div className="flex flex-col gap-1.5 text-center">
          <h2 className="text-lg font-medium text-ink">Ты сейчас на какой стороне?</h2>
          <p className="text-xs text-slate-500">
            {askReason === "cooldown"
              ? "Перерыв после сделки закончился. Прислушайся: что подсказывают ощущения — входить в рынок или дать себе ещё паузу?"
              : "Прислушайся к себе: что подсказывают ощущения — входить сегодня в рынок или поберечь себя?"}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <MoodButton
            emoji="😌"
            label="Спокойно"
            caption="Могу торговать по плану"
            tone="calm"
            disabled={isSaving}
            onClick={() => answer(true)}
          />
          <MoodButton
            emoji="😵‍💫"
            label="Тревожно"
            caption="Качает — пауза 2 часа"
            tone="storm"
            disabled={isSaving}
            onClick={() => answer(false)}
          />
        </div>

        {error && <p className="text-center text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
}

/** Напоминание после тревожного ответа — висит у формы открытия до следующего вопроса. */
export function NotResourcefulNotice() {
  return (
    <div className="mx-4 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <span className="text-2xl leading-none" aria-hidden="true">
        😵‍💫
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-amber-800">Сегодня тебя качает</p>
        <p className="text-xs text-amber-700">
          По твоей же отметке. Лучший план на сегодня — вернуть себе опору, а не торговать.
        </p>
      </div>
    </div>
  );
}

import { useState } from "react";
import { ApiError, setResourceStateRequest } from "../../api/client";
import type { ResourceState } from "../../api/types";

/**
 * Поп-ап «Ты сегодня в ресурсном состоянии?» — задаётся один раз за торговый день, при
 * первом открытии приложения после сброса дня (правило пользователя от 16.09.2026).
 * Ответ хранится на сервере, поэтому с любого устройства спросят ровно один раз.
 *
 * Ничего не блокирует: «нет» — это не запрет торговли, а напоминание на весь день
 * (см. NotResourcefulNotice). Закрыть поп-ап можно только ответом — вопрос на один тап.
 */
export function ResourceStatePrompt({ onAnswered }: { onAnswered: (state: ResourceState) => void }) {
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
        <div className="flex flex-col gap-1.5">
          <h2 className="text-base font-medium text-ink">Ты сегодня в ресурсном состоянии?</h2>
          <p className="text-xs text-slate-500">
            Отвечаем один раз за день — торговля из ресурса и торговля из пустоты дают разный
            результат.
          </p>
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={isSaving}
            onClick={() => answer(true)}
            className="flex-1 rounded-xl bg-accent py-3 text-sm font-medium text-surface disabled:opacity-50"
          >
            Да
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={() => answer(false)}
            className="flex-1 rounded-xl border border-line py-3 text-sm font-medium text-slate-600 disabled:opacity-50"
          >
            Нет
          </button>
        </div>
      </div>
    </div>
  );
}

/** Напоминание на весь день после ответа «нет» — висит рядом с формой открытия сделки. */
export function NotResourcefulNotice() {
  return (
    <div className="mx-4 flex flex-col gap-1 rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm font-medium text-amber-800">Сегодня ты не в ресурсе</p>
      <p className="text-xs text-amber-700">
        По твоей отметке в начале дня. Лучший план на сегодня — наполнить себя ресурсом, а не
        торговать.
      </p>
    </div>
  );
}

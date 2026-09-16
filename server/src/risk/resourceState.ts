/**
 * Отметка «в ресурсе / не в ресурсе» на торговый день (правило пользователя от 16.09.2026).
 * Вопрос задаётся поп-апом при первом входе в приложение после сброса дня (07:00 по
 * настройкам риск-плана) — ровно один раз за день, на какой бы устройстве ни ответили.
 *
 * Ответ «нет» ничего не блокирует: торговля остаётся доступной, но рядом с формой
 * открытия весь день висит напоминание. Это осознанно мягкое правило — решение всё равно
 * за пользователем (в отличие от лимитов риск-движка, которые блокируют).
 */

/** Что лежит в kv-настройках (settings, ключ resource_state). */
export type StoredResourceState = {
  /** Ключ торгового дня (getTradingDayKey), за который дан ответ. */
  dayKey: string;
  isResourceful: boolean;
  answeredAt: string;
};

/** Что отдаём клиенту — всегда про ТЕКУЩИЙ торговый день. */
export type ResourceStateView = {
  dayKey: string;
  /** Отвечали ли уже сегодня; false — показать поп-ап. */
  answered: boolean;
  /** null — сегодня ещё не отвечали. */
  isResourceful: boolean | null;
};

/**
 * Ответ прошлого дня к сегодняшнему не относится: сравниваем ключ дня, а не дату
 * сохранения — день сбрасывается в 07:00, а не в полночь.
 */
export function resolveResourceState(
  stored: StoredResourceState | null,
  todayKey: string,
): ResourceStateView {
  if (!stored || stored.dayKey !== todayKey) {
    return { dayKey: todayKey, answered: false, isResourceful: null };
  }
  return { dayKey: todayKey, answered: true, isResourceful: stored.isResourceful };
}

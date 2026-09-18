/**
 * Отметка «в ресурсе / не в ресурсе» (правило пользователя от 16.09.2026, дополнено
 * 18.09.2026). Вопрос задаётся поп-апом при входе в приложение в двух случаях:
 *
 * 1. начался новый ТОРГОВЫЙ день (сброс в 07:00 по настройкам, не в полночь);
 * 2. закончился часовой перерыв после закрытой сделки (кулдаун риск-движка) — то есть
 *    ровно в тот момент, когда снова можно входить в рынок.
 *
 * Оба случая — «точки пересборки»: спрашиваем один раз на точку, повторно не дёргаем.
 * Ответ «нет» ничего не блокирует: торговля остаётся доступной, но рядом с формой
 * открытия висит напоминание. Это осознанно мягкое правило — решение за пользователем
 * (в отличие от лимитов риск-движка, которые блокируют).
 */

/** Что лежит в kv-настройках (settings, ключ resource_state). */
export type StoredResourceState = {
  /** Ключ торгового дня (getTradingDayKey), за который дан ответ. */
  dayKey: string;
  isResourceful: boolean;
  /** ISO-время ответа — по нему видно, был ли ответ ДО конца последнего кулдауна. */
  answeredAt: string;
};

/** Почему спрашиваем — от этого зависит текст поп-апа. */
export type ResourceAskReason = "day" | "cooldown";

/** Что отдаём клиенту — всегда про текущий момент. */
export type ResourceStateView = {
  dayKey: string;
  /** Отвечали ли уже на текущую «точку пересборки»; false — показать поп-ап. */
  answered: boolean;
  /** null — на текущую точку ещё не отвечали. */
  isResourceful: boolean | null;
  /** Заполнено, когда answered === false: новый день или конец перерыва. */
  askReason: ResourceAskReason | null;
};

export type ResourceStateInput = {
  stored: StoredResourceState | null;
  /** Ключ текущего торгового дня (risk/tradingDay.ts). */
  todayKey: string;
  now: Date;
  /** Время закрытия последней сделки — от него отсчитывается конец кулдауна. */
  lastTradeClosedAt: Date | null;
  /** Длина перерыва после сделки из риск-настроек, в минутах. */
  cooldownMinutes: number;
};

/** Момент окончания последнего перерыва после сделки; null — сделок ещё не было. */
function cooldownEndedAt(input: ResourceStateInput): Date | null {
  if (!input.lastTradeClosedAt) return null;
  const end = new Date(input.lastTradeClosedAt.getTime() + input.cooldownMinutes * 60_000);
  // Перерыв ещё идёт — спрашивать рано, спросим на входе после его окончания.
  return end <= input.now ? end : null;
}

export function resolveResourceState(input: ResourceStateInput): ResourceStateView {
  const { stored, todayKey } = input;
  const ask = (askReason: ResourceAskReason): ResourceStateView => ({
    dayKey: todayKey,
    answered: false,
    isResourceful: null,
    askReason,
  });

  if (!stored || stored.dayKey !== todayKey) {
    return ask("day");
  }

  const cooldownEnd = cooldownEndedAt(input);
  const answeredAtMs = Date.parse(stored.answeredAt);
  // Ответ дан ДО того, как закончился перерыв, — после перерыва спрашиваем заново.
  if (cooldownEnd !== null && (!Number.isFinite(answeredAtMs) || answeredAtMs < cooldownEnd.getTime())) {
    return ask("cooldown");
  }

  return { dayKey: todayKey, answered: true, isResourceful: stored.isResourceful, askReason: null };
}

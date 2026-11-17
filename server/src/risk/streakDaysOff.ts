import type { Block, RiskLimitsConfig } from "./limits.js";
import type { StopChainDay } from "./stopChain.js";
import { getResetAtAfterTradingDay } from "./tradingDay.js";

/**
 * Два правила «выходной после серии» (запрос пользователя от 17.11.2026). Оба закрывают
 * торговлю до конца ТЕКУЩЕГО торгового дня и на ВЕСЬ следующий, потом торговля идёт как
 * обычно:
 *
 * - **Правило #20 «пять тейков подряд»**: пятая подряд сделка, закрытая тейком, даёт
 *   выходной. Серия идёт сквозь дни; её обрывает только стоп; безубыток и ручное/внешнее
 *   закрытие нейтральны — не считаются и не обнуляют (та же логика, что у лестницы пауз,
 *   только зеркальная). После срабатывания серия считается заново — «каждый раз».
 *   Смысл: длинная серия прибыли расслабляет не хуже серии убытков; пауза на пике —
 *   дёшево купленная дисциплина.
 *
 * - **Правило #21 «стопы на стыке дней»**: КРАЙНЯЯ сделка предыдущего торгового дня и
 *   ПЕРВАЯ сделка текущего — обе закрыты стопом. «Предыдущий день» — последний день, в
 *   котором вообще были закрытые сделки, а не календарный вчера: выходные и паузы между
 *   ними картину не меняют. Исход краевых сделок берётся строго: безубыток или ручное
 *   закрытие на краю — не стоп, правило не срабатывает.
 *   Смысл: закончить день стопом и начать следующий со стопа — признак, что рынок
 *   не читается; продолжать в тот же день не стоит.
 *
 * Как и лестница пауз, состояние не хранится: оно выводится из истории закрытых сделок,
 * поэтому переразметка исхода в админке чинит оба правила сама. Вход — те же дни с
 * исходами, что у computeStopChain (risk/service.ts → toStopChainDays).
 *
 * «Тейк» и «стоп» здесь — исход по экономике сделки (history/outcome.ts): стоп, уведённый
 * в прибыль, — это тейк.
 */

/** Сколько тейков подряд дают выходной (правило #20). */
export const TAKE_STREAK_LENGTH = 5;

/** День, в который правило сработало в последний раз, или null — не срабатывало. */
export type StreakTrigger = { dayKey: string } | null;

/**
 * Правило #20: последний день, в который набрался пятый тейк подряд. Счётчик идёт сквозь
 * дни, стоп его обнуляет, безубыток/ручное закрытие нейтральны; после срабатывания
 * серия начинается заново. Возвращается ПОСЛЕДНЕЕ срабатывание: прежние и так истекли
 * по сроку блокировки.
 */
export function computeTakeStreakTrigger(days: StopChainDay[]): StreakTrigger {
  let streak = 0;
  let trigger: StreakTrigger = null;
  for (const day of days) {
    for (const outcome of day.outcomes) {
      if (outcome === "sl") {
        streak = 0;
        continue;
      }
      if (outcome !== "tp") continue;
      streak += 1;
      if (streak >= TAKE_STREAK_LENGTH) {
        trigger = { dayKey: day.dayKey };
        streak = 0;
      }
    }
  }
  return trigger;
}

/**
 * Правило #21: сработало ли «стопы на стыке дней» СЕГОДНЯ. Триггер всегда привязан к
 * текущему дню: прошлые стыки уже отжили свои блокировки, пересчитывать их незачем.
 */
export function computeEdgeStopsTrigger(days: StopChainDay[], todayKey: string): StreakTrigger {
  const todayIndex = days.findIndex((day) => day.dayKey === todayKey);
  if (todayIndex === -1) return null;
  const today = days[todayIndex]!;
  if (today.outcomes[0] !== "sl") return null;

  // Предыдущий день С СДЕЛКАМИ: toStopChainDays не создаёт пустых дней, поэтому это
  // просто предыдущий элемент списка.
  const previous = todayIndex > 0 ? days[todayIndex - 1]! : null;
  if (!previous || previous.outcomes.length === 0) return null;
  if (previous.outcomes[previous.outcomes.length - 1] !== "sl") return null;

  return { dayKey: todayKey };
}

/**
 * Блокировка «день закрыт + следующий выходной» по сработавшему правилу, или null —
 * не срабатывало либо срок уже вышел. Механика срока та же, что у лестницы пауз:
 * день срабатывания заканчивается сбросом, сверху ровно один полный день.
 */
export function buildStreakDayOffBlock(
  now: Date,
  trigger: StreakTrigger,
  block: { type: Block["type"]; reason: string },
  config: Pick<RiskLimitsConfig, "resetHour" | "tzOffsetMinutes">,
): Block | null {
  if (trigger === null) return null;
  const until = getResetAtAfterTradingDay(trigger.dayKey, 1, config.resetHour, config.tzOffsetMinutes);
  if (until === null || until <= now) return null;
  return { type: block.type, reason: block.reason, until };
}

/** Тексты блокировок — короткие, под плашку с таймером (≤ 60 символов). */
export const TAKE_STREAK_REASON = "5 тейков подряд — заслуженный выходной";
export const EDGE_STOPS_REASON = "Стоп на закрытии дня и стоп с утра — выходной";

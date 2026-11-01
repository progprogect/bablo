import { getLevelDef, type RiskLevelDef, type RiskState } from "./ladder.js";

/**
 * Ручная установка состояния риск-плана из админки (01.11.2026). Понадобилась при
 * переезде с Railway: база осталась у заблокированного хостинга, а приложение поднялось
 * с пустой — и считало риск от первого уровня, хотя реальный прогресс был другим.
 * Пользователь помнит свой уровень, поэтому самый быстрый способ вернуть правильный
 * риск на сделку — ввести его руками.
 *
 * Обычный путь (applyTradeResult по закрытым сделкам) при этом не трогается: ручная
 * установка — разовая правка состояния, а не второй механизм прогресса.
 *
 * Чистая проверка без I/O: решение здесь, запись в БД — в api/admin.ts.
 */

export type ManualRiskStateInput = {
  currentLevel: number;
  accumulatedR: number;
};

/**
 * Проверяет заявку на установку состояния. Возвращает текст ошибки или null.
 * `levels` — лестница из БД: уровень обязан существовать в ней, иначе риск сделки
 * будет считаться от несуществующей ступени.
 */
export function validateManualRiskState(
  input: ManualRiskStateInput,
  levels: RiskLevelDef[],
): string | null {
  if (!Number.isInteger(input.currentLevel)) {
    return "Уровень должен быть целым числом";
  }
  if (getLevelDef(levels, input.currentLevel) === undefined) {
    const max = levels.reduce((best, level) => Math.max(best, level.level), 0);
    return `Уровня ${input.currentLevel} нет в лестнице (доступны 1–${max})`;
  }
  if (!Number.isFinite(input.accumulatedR)) {
    return "Накопленный R должен быть числом";
  }
  if (input.accumulatedR < 0) {
    return "Накопленный R не может быть отрицательным";
  }
  const required = getLevelDef(levels, input.currentLevel)?.requiredR ?? null;
  // Прогресс, уже перекрывающий норму уровня, означал бы, что уровень давно пройден:
  // такое состояние лестница сама никогда не создаёт (остаток переносится вверх).
  if (required !== null && input.accumulatedR >= required) {
    return `Накопленный R должен быть меньше ${required}R — столько нужно для следующего уровня`;
  }
  return null;
}

/** Состояние для записи в БД — после успешной проверки. */
export function toRiskState(input: ManualRiskStateInput): RiskState {
  return { currentLevel: input.currentLevel, accumulatedR: input.accumulatedR };
}

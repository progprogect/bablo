export type RiskLevelDef = {
  level: number;
  riskUsd: number;
  requiredR: number;
};

export type RiskState = {
  currentLevel: number;
  accumulatedR: number;
};

/**
 * Применяет результат закрытой сделки (в R) к прогрессу лестницы уровней.
 * Уровень никогда не понижается, прогресс не опускается ниже 0R (docs/RISK_ENGINE.md).
 * Крупный выигрыш может перепрыгнуть сразу несколько уровней — остаток R переносится
 * на следующий уровень. На последнем уровне лестницы прогресс продолжает копиться
 * без ограничения сверху (следующего уровня нет).
 */
export function applyTradeResult(
  state: RiskState,
  resultR: number,
  levels: RiskLevelDef[],
): RiskState {
  let currentLevel = state.currentLevel;
  let accumulatedR = Math.max(0, state.accumulatedR + resultR);

  const maxLevel = levels.reduce((max, l) => Math.max(max, l.level), 0);

  for (;;) {
    if (currentLevel >= maxLevel) break;
    const definition = levels.find((l) => l.level === currentLevel);
    if (!definition || accumulatedR < definition.requiredR) break;
    accumulatedR -= definition.requiredR;
    currentLevel += 1;
  }

  return { currentLevel, accumulatedR };
}

/** Находит определение уровня по номеру. */
export function getLevelDef(levels: RiskLevelDef[], level: number): RiskLevelDef | undefined {
  return levels.find((l) => l.level === level);
}

/** Максимальный объём (в монетах), укладывающийся в риск 1R текущего уровня. */
export function computeMaxQuantity(currentPrice: number, slPrice: number, levelRiskUsd: number): number {
  const priceDistance = Math.abs(currentPrice - slPrice);
  if (priceDistance <= 0) return 0;
  return levelRiskUsd / priceDistance;
}

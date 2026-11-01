import { test } from "node:test";
import assert from "node:assert/strict";
import { toRiskState, validateManualRiskState } from "./manualState.js";
import type { RiskLevelDef } from "./ladder.js";

const LEVELS: RiskLevelDef[] = [
  { level: 1, riskUsd: 5, requiredR: 5 },
  { level: 2, riskUsd: 10, requiredR: 5 },
  { level: 3, riskUsd: 15, requiredR: 5 },
];

test("уровень из лестницы и прогресс в её пределах — ошибок нет", () => {
  assert.equal(validateManualRiskState({ currentLevel: 2, accumulatedR: 2.5 }, LEVELS), null);
  assert.equal(validateManualRiskState({ currentLevel: 1, accumulatedR: 0 }, LEVELS), null);
});

test("уровня нет в лестнице — ошибка называет доступный диапазон", () => {
  const error = validateManualRiskState({ currentLevel: 9, accumulatedR: 0 }, LEVELS);
  assert.match(error ?? "", /Уровня 9 нет/);
  assert.match(error ?? "", /1–3/);
});

test("дробный уровень не принимается", () => {
  assert.match(validateManualRiskState({ currentLevel: 2.5, accumulatedR: 0 }, LEVELS) ?? "", /целым/);
});

test("отрицательный прогресс не принимается", () => {
  assert.match(validateManualRiskState({ currentLevel: 2, accumulatedR: -1 }, LEVELS) ?? "", /отрицательным/);
});

test("прогресс не меньше нормы уровня — это уже следующий уровень", () => {
  // 5R на втором уровне означали бы, что он пройден: лестница сама так не оставляет.
  assert.match(validateManualRiskState({ currentLevel: 2, accumulatedR: 5 }, LEVELS) ?? "", /меньше 5R/);
  assert.equal(validateManualRiskState({ currentLevel: 2, accumulatedR: 4.9 }, LEVELS), null);
});

test("нечисловой прогресс не принимается", () => {
  assert.match(validateManualRiskState({ currentLevel: 2, accumulatedR: NaN }, LEVELS) ?? "", /числом/);
});

test("toRiskState отдаёт ровно то, что ввели", () => {
  assert.deepEqual(toRiskState({ currentLevel: 7, accumulatedR: 1.5 }), {
    currentLevel: 7,
    accumulatedR: 1.5,
  });
});

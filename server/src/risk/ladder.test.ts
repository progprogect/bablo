import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTradeResult, computeMaxQuantity } from "./ladder.js";
import { DEFAULT_RISK_LEVELS } from "./defaultLevels.js";

test("applyTradeResult: положительный результат копит прогресс без перехода уровня", () => {
  const result = applyTradeResult({ currentLevel: 1, accumulatedR: 0 }, 2, DEFAULT_RISK_LEVELS);
  assert.deepEqual(result, { currentLevel: 1, accumulatedR: 2 });
});

test("applyTradeResult: достижение requiredR переводит на следующий уровень с переносом остатка", () => {
  // уровень 1 требует +5R; 3 + 4 = 7 → переход на уровень 2 с остатком 2R
  const afterFirst = applyTradeResult({ currentLevel: 1, accumulatedR: 3 }, 4, DEFAULT_RISK_LEVELS);
  assert.deepEqual(afterFirst, { currentLevel: 2, accumulatedR: 2 });
});

test("applyTradeResult: крупный выигрыш перепрыгивает несколько уровней", () => {
  // с уровня 1 (requiredR=5 на каждом из уровней 1-9): +23R -> 1→2(-5=18)→3(-5=13)→4(-5=8)→5(-5=3), остаётся 3R
  const result = applyTradeResult({ currentLevel: 1, accumulatedR: 0 }, 23, DEFAULT_RISK_LEVELS);
  assert.deepEqual(result, { currentLevel: 5, accumulatedR: 3 });
});

test("applyTradeResult: отрицательный результат не опускает прогресс ниже 0 и не понижает уровень", () => {
  const result = applyTradeResult({ currentLevel: 3, accumulatedR: 1 }, -4, DEFAULT_RISK_LEVELS);
  assert.deepEqual(result, { currentLevel: 3, accumulatedR: 0 });
});

test("applyTradeResult: уровень не растёт выше максимального, прогресс копится дальше", () => {
  const result = applyTradeResult({ currentLevel: 26, accumulatedR: 50 }, 80, DEFAULT_RISK_LEVELS);
  assert.deepEqual(result, { currentLevel: 26, accumulatedR: 130 });
});

test("computeMaxQuantity: делит 1R на дистанцию до стопа", () => {
  assert.ok(Math.abs(computeMaxQuantity(1, 0.9, 10) - 100) < 1e-9);
});

test("computeMaxQuantity: нулевая дистанция даёт 0 (защита от деления на 0)", () => {
  assert.equal(computeMaxQuantity(1, 1, 10), 0);
});

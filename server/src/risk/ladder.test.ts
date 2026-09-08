import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTradeResult, computeMaxQuantity, riskSizeToleranceRatio } from "./ladder.js";
import { DEFAULT_RISK_LEVELS, MAX_RISK_LEVEL } from "./defaultLevels.js";

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
  const result = applyTradeResult({ currentLevel: MAX_RISK_LEVEL, accumulatedR: 50 }, 80, DEFAULT_RISK_LEVELS);
  assert.deepEqual(result, { currentLevel: MAX_RISK_LEVEL, accumulatedR: 130 });
});

test("computeMaxQuantity: делит 1R на дистанцию до стопа", () => {
  assert.ok(Math.abs(computeMaxQuantity(1, 0.9, 10) - 100) < 1e-9);
});

test("computeMaxQuantity: нулевая дистанция даёт 0 (защита от деления на 0)", () => {
  assert.equal(computeMaxQuantity(1, 1, 10), 0);
});

test("riskSizeToleranceRatio: единый ±8% на всех уровнях", () => {
  assert.equal(riskSizeToleranceRatio(1), 0.08);
  assert.equal(riskSizeToleranceRatio(2), 0.08);
  assert.equal(riskSizeToleranceRatio(3), 0.08);
  assert.equal(riskSizeToleranceRatio(10), 0.08);
  assert.equal(riskSizeToleranceRatio(0), 0.08);
});

test("DEFAULT_RISK_LEVELS: 50 ступеней, номера подряд, риск строго возрастает", () => {
  assert.equal(DEFAULT_RISK_LEVELS.length, 50);
  assert.equal(MAX_RISK_LEVEL, 50);
  DEFAULT_RISK_LEVELS.forEach((definition, index) => {
    assert.equal(definition.level, index + 1);
    if (index > 0) {
      // Номер уровня обязан расти вместе с риском: миграция 0012 переносит пользователя
      // на ступень с тем же риском именно по этому свойству.
      assert.ok(definition.riskUsd > DEFAULT_RISK_LEVELS[index - 1]!.riskUsd);
    }
  });
});

test("DEFAULT_RISK_LEVELS: везде +5R, кроме потолка (31.08.2026 — было +10R выше 100)", () => {
  const growth = DEFAULT_RISK_LEVELS.slice(0, -1);
  assert.ok(growth.every((definition) => definition.requiredR === 5));
  assert.equal(DEFAULT_RISK_LEVELS.at(-1)?.riskUsd, 1000);
});

test("DEFAULT_RISK_LEVELS: новые ступени добавлены, прежние сохранены", () => {
  const ladder = DEFAULT_RISK_LEVELS.map((definition) => definition.riskUsd);
  const added = [
    120, 140, 160, 180, 220, 240, 260, 280, 320, 340, 360, 380,
    420, 440, 460, 480, 520, 570, 620, 670, 720, 770, 850, 950,
  ];
  const before = [10, 50, 90, 100, 150, 250, 350, 450, 550, 650, 750, 800, 900, 1000];
  assert.ok(added.every((riskUsd) => ladder.includes(riskUsd)));
  assert.ok(before.every((riskUsd) => ladder.includes(riskUsd)));
});

test("applyTradeResult: +5R поднимает уровень и выше 100 USDT", () => {
  // Уровень 10 = 100 USDT: раньше требовалось +10R, теперь +5R.
  const result = applyTradeResult({ currentLevel: 10, accumulatedR: 0 }, 5, DEFAULT_RISK_LEVELS);
  assert.deepEqual(result, { currentLevel: 11, accumulatedR: 0 });
  assert.equal(DEFAULT_RISK_LEVELS.find((l) => l.level === 11)?.riskUsd, 120);
});

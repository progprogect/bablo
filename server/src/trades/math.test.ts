import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computePartialTpQuantity,
  computeResultFromPrices,
  computeTakeProfitPrice,
  decimalsOf,
  isValidPartialTakeProfit,
  isValidStopLoss,
  isValidTakeProfit,
  parseRRRatio,
} from "./math.js";

test("computeResultFromPrices: long в плюсе даёт положительный R", () => {
  const { resultR, resultPct } = computeResultFromPrices("long", 100, 110, 10, 50);
  assert.equal(resultR, 2); // (110-100)*10 / 50
  assert.ok(Math.abs(resultPct - 10) < 1e-9);
});

test("computeResultFromPrices: short в плюсе (цена упала) даёт положительный R", () => {
  const { resultR } = computeResultFromPrices("short", 100, 90, 10, 50);
  assert.equal(resultR, 2); // (100-90)*10 / 50
});

test("computeResultFromPrices: long в минусе даёт отрицательный R", () => {
  const { resultR } = computeResultFromPrices("long", 100, 95, 10, 50);
  assert.equal(resultR, -1);
});

test("computeResultFromPrices: riskUsd = 0 не делит на ноль", () => {
  const { resultR } = computeResultFromPrices("long", 100, 110, 10, 0);
  assert.equal(resultR, 0);
});

test("parseRRRatio распознаёт стандартные пресеты", () => {
  assert.equal(parseRRRatio("1/2"), 2);
  assert.equal(parseRRRatio("1/1.5"), 1.5);
  assert.equal(parseRRRatio("2/1"), null);
});

test("parseRRRatio отклоняет пресеты вне согласованного списка (RR_PRESETS)", () => {
  assert.equal(parseRRRatio("1/2.5"), null);
  assert.equal(parseRRRatio("1/100"), null);
});

test("computeTakeProfitPrice: long считает TP выше входа", () => {
  const tp = computeTakeProfitPrice(100, 95, "long", 2);
  assert.equal(tp, 110); // риск 5, прибыль 10
});

test("isValidStopLoss/isValidTakeProfit: базовые направления", () => {
  assert.equal(isValidStopLoss(100, 95, "long"), true);
  assert.equal(isValidStopLoss(100, 105, "long"), false);
  assert.equal(isValidTakeProfit(100, 110, "long"), true);
  assert.equal(isValidTakeProfit(100, 90, "short"), true);
});

test("isValidPartialTakeProfit: цена должна лежать строго между входом и TP", () => {
  assert.equal(isValidPartialTakeProfit(100, 120, 110, "long"), true);
  assert.equal(isValidPartialTakeProfit(100, 120, 100, "long"), false); // равно входу
  assert.equal(isValidPartialTakeProfit(100, 120, 120, "long"), false); // равно TP
  assert.equal(isValidPartialTakeProfit(100, 120, 130, "long"), false); // за TP
  assert.equal(isValidPartialTakeProfit(100, 80, 90, "short"), true);
  assert.equal(isValidPartialTakeProfit(100, 80, 70, "short"), false); // за TP
});

test("decimalsOf: считает знаки после запятой у строки", () => {
  assert.equal(decimalsOf("10"), 0);
  assert.equal(decimalsOf("10.5"), 1);
  assert.equal(decimalsOf("10.1234"), 4);
});

test("computePartialTpQuantity: 70% с округлением вниз до точности объёма", () => {
  assert.equal(computePartialTpQuantity(10, 0), 7);
  assert.equal(computePartialTpQuantity(1, 2), 0.7);
  // 10.33 * 0.7 = 7.231 → округление вниз до 2 знаков
  assert.equal(computePartialTpQuantity(10.33, 2), 7.23);
});

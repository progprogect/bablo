import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAdjustedOrders,
  parseAdjustingTpRatio,
  computePartialTpQuantity,
  computeRemainderQuantity,
  computeResultFromPrices,
  computeRiskRewardRatio,
  computeSlPriceAfterPartial,
  computeTakeProfitPrice,
  decideMoveSlAfterPartial,
  decimalsOf,
  isPartialTakeProfitNearRatio,
  isPartialTakeProfitWithinMaxRatio,
  isSlAtOrBeyondTarget,
  isStopOnProfitSide,
  isValidPartialTakeProfit,
  isValidStopLoss,
  isValidTakeProfit,
  parseRRRatio,
  requiresPartialTakeProfit,
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
  assert.equal(parseRRRatio("1/6"), 6);
  assert.equal(parseRRRatio("2/1"), null);
});

test("parseRRRatio отклоняет пресеты вне согласованного списка (RR_PRESETS)", () => {
  assert.equal(parseRRRatio("1/2.5"), null);
  // 1/7–1/10 убраны из выбора при открытии сделки (решение от 30.08.2026);
  // старые строки в БД просто перестают парситься.
  assert.equal(parseRRRatio("1/10"), null);
  assert.equal(parseRRRatio("1/11"), null);
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

test("requiresPartialTakeProfit: с 1/5 и выше — обязательно", () => {
  assert.equal(requiresPartialTakeProfit(4), false);
  assert.equal(requiresPartialTakeProfit(4.99), false);
  assert.equal(requiresPartialTakeProfit(5), true);
  assert.equal(requiresPartialTakeProfit(10), true);
});

test("computeRiskRewardRatio: считает R/R по ценам", () => {
  assert.equal(computeRiskRewardRatio(100, 95, 110), 2); // риск 5, прибыль 10
  assert.equal(computeRiskRewardRatio(100, 95, 125), 5);
  assert.equal(computeRiskRewardRatio(100, 100, 110), null); // нулевой риск
});

test("isPartialTakeProfitWithinMaxRatio: не дальше 1/3", () => {
  assert.equal(isPartialTakeProfitWithinMaxRatio(100, 95, 110), true); // 2R
  assert.equal(isPartialTakeProfitWithinMaxRatio(100, 95, 115), true); // 3R
  assert.equal(isPartialTakeProfitWithinMaxRatio(100, 95, 115.1), false); // > 3R
  assert.equal(isPartialTakeProfitWithinMaxRatio(100, 95, 120), false); // 4R
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

test("isPartialTakeProfitNearRatio: отличает 1/3 от 1/2 и 1/1", () => {
  // entry 100, sl 90 → risk 10; 1/3 = 130, 1/2 = 120, 1/1 = 110
  assert.equal(isPartialTakeProfitNearRatio(100, 90, 130, 3), true);
  assert.equal(isPartialTakeProfitNearRatio(100, 90, 120, 3), false);
  assert.equal(isPartialTakeProfitNearRatio(100, 90, 110, 3), false);
  // short: entry 100, sl 110 → 1/3 = 70
  assert.equal(isPartialTakeProfitNearRatio(100, 110, 70, 3), true);
  assert.equal(isPartialTakeProfitNearRatio(100, 110, 80, 3), false);
});

test("isStopOnProfitSide: long/short", () => {
  assert.equal(isStopOnProfitSide(100, 95, "long"), false);
  assert.equal(isStopOnProfitSide(100, 100, "long"), true);
  assert.equal(isStopOnProfitSide(100, 110, "long"), true);
  assert.equal(isStopOnProfitSide(100, 105, "short"), false);
  assert.equal(isStopOnProfitSide(100, 100, "short"), true);
  assert.equal(isStopOnProfitSide(100, 90, "short"), true);
});

test("isSlAtOrBeyondTarget / computeSlPriceAfterPartial", () => {
  assert.equal(computeSlPriceAfterPartial(100, 90, "long", 0), 100);
  assert.equal(computeSlPriceAfterPartial(100, 90, "long", 1), 110);
  assert.equal(computeSlPriceAfterPartial(100, 110, "short", 0), 100);
  assert.equal(computeSlPriceAfterPartial(100, 110, "short", 1), 90);
  assert.equal(isSlAtOrBeyondTarget(100, 100, "long"), true);
  assert.equal(isSlAtOrBeyondTarget(99, 100, "long"), false);
  assert.equal(isSlAtOrBeyondTarget(100, 100, "short"), true);
  assert.equal(isSlAtOrBeyondTarget(101, 100, "short"), false);
});

test("decideMoveSlAfterPartial: long — partial 1/3 → SL на 1/1", () => {
  const decision = decideMoveSlAfterPartial({
    side: "long",
    entryPrice: 100,
    slPrice: 90,
    partialTpPrice: 130,
    partialTpFilledAt: new Date(),
    quantity: 10,
    partialTpQuantity: 7,
  });
  assert.equal(decision.action, "move");
  if (decision.action === "move") {
    assert.equal(decision.newSlPrice, 110); // 1/1
    assert.equal(decision.remainderQuantity, 3);
    assert.equal(decision.partialRatio, 3);
    assert.equal(decision.slRatio, 1);
  }
});

test("decideMoveSlAfterPartial: short — partial 1/3 → SL на 1/1", () => {
  const decision = decideMoveSlAfterPartial({
    side: "short",
    entryPrice: 100,
    slPrice: 110,
    partialTpPrice: 70,
    partialTpFilledAt: new Date(),
    quantity: 10,
    partialTpQuantity: 7,
  });
  assert.equal(decision.action, "move");
  if (decision.action === "move") {
    assert.equal(decision.newSlPrice, 90);
    assert.equal(decision.remainderQuantity, 3);
    assert.equal(decision.partialRatio, 3);
    assert.equal(decision.slRatio, 1);
  }
});

test("decideMoveSlAfterPartial: long — partial 1/2 → SL на вход", () => {
  const decision = decideMoveSlAfterPartial({
    side: "long",
    entryPrice: 100,
    slPrice: 90,
    partialTpPrice: 120,
    partialTpFilledAt: new Date(),
    quantity: 10,
    partialTpQuantity: 7,
  });
  assert.equal(decision.action, "move");
  if (decision.action === "move") {
    assert.equal(decision.newSlPrice, 100); // вход
    assert.equal(decision.remainderQuantity, 3);
    assert.equal(decision.partialRatio, 2);
    assert.equal(decision.slRatio, 0);
  }
});

test("decideMoveSlAfterPartial: short — partial 1/2 → SL на вход", () => {
  const decision = decideMoveSlAfterPartial({
    side: "short",
    entryPrice: 100,
    slPrice: 110,
    partialTpPrice: 80,
    partialTpFilledAt: new Date(),
    quantity: 10,
    partialTpQuantity: 7,
  });
  assert.equal(decision.action, "move");
  if (decision.action === "move") {
    assert.equal(decision.newSlPrice, 100);
    assert.equal(decision.remainderQuantity, 3);
    assert.equal(decision.partialRatio, 2);
    assert.equal(decision.slRatio, 0);
  }
});

test("decideMoveSlAfterPartial: partial на 1/1 — skip (ход был бы только 1R)", () => {
  const decision = decideMoveSlAfterPartial({
    side: "long",
    entryPrice: 100,
    slPrice: 90,
    partialTpPrice: 110,
    partialTpFilledAt: new Date(),
    quantity: 10,
    partialTpQuantity: 7,
  });
  assert.equal(decision.action, "skip");
});

test("decideMoveSlAfterPartial: SL уже на прибыли — skip (идемпотентность)", () => {
  const decision = decideMoveSlAfterPartial({
    side: "long",
    entryPrice: 100,
    slPrice: 110,
    partialTpPrice: 130,
    partialTpFilledAt: new Date(),
    quantity: 10,
    partialTpQuantity: 7,
  });
  assert.equal(decision.action, "skip");
});

test("decideMoveSlAfterPartial: SL уже на входе после 1/2 — skip", () => {
  const decision = decideMoveSlAfterPartial({
    side: "long",
    entryPrice: 100,
    slPrice: 100,
    partialTpPrice: 120,
    partialTpFilledAt: new Date(),
    quantity: 10,
    partialTpQuantity: 7,
  });
  assert.equal(decision.action, "skip");
});

test("decideMoveSlAfterPartial: partial ещё не исполнена — skip", () => {
  const decision = decideMoveSlAfterPartial({
    side: "long",
    entryPrice: 100,
    slPrice: 90,
    partialTpPrice: 130,
    partialTpFilledAt: null,
    quantity: 10,
    partialTpQuantity: 7,
  });
  assert.equal(decision.action, "skip");
});

test("computeRemainderQuantity: не уходит в минус", () => {
  assert.equal(computeRemainderQuantity(10, 7), 3);
  assert.equal(computeRemainderQuantity(10, 10), 0);
  assert.equal(computeRemainderQuantity(10, 12), 0);
});

test("computeAdjustedOrders: лонг 1/0.9 — TP на 0.9R, SL на −0.9R (соотношение 1/1)", () => {
  // вход 100, SL 90 → R₀ = 10
  const result = computeAdjustedOrders(100, 90, "long", 0.9);
  assert.ok(result);
  assert.equal(result.tpPrice, 109);
  assert.equal(result.newSlPrice, 91);
});

test("computeAdjustedOrders: лонг 1/1.9 — TP на 1.9R, SL на −0.9R", () => {
  const result = computeAdjustedOrders(100, 90, "long", 1.9);
  assert.ok(result);
  assert.equal(result.tpPrice, 119);
  assert.equal(result.newSlPrice, 91);
});

test("computeAdjustedOrders: шорт — зеркально", () => {
  const result = computeAdjustedOrders(100, 110, "short", 0.9);
  assert.ok(result);
  assert.equal(result.tpPrice, 91);
  assert.equal(result.newSlPrice, 109);
});

test("computeAdjustedOrders: SL на входе (нет дистанции) — null", () => {
  assert.equal(computeAdjustedOrders(100, 100, "long", 0.9), null);
});

test("parseAdjustingTpRatio: только выравнивающие пресеты", () => {
  assert.equal(parseAdjustingTpRatio("1/0.9"), 0.9);
  assert.equal(parseAdjustingTpRatio("1/1.9"), 1.9);
  assert.equal(parseAdjustingTpRatio("1/1"), null);
  assert.equal(parseAdjustingTpRatio("1/2"), null);
});

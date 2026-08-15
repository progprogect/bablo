import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeRewardPriceFromRiskUsd,
  decideNightTakeProfit,
} from "./nightTp.js";

const TZ = 180;
const RESET = 7;

const openedDay = new Date("2026-07-14T10:00:00Z"); // 13:00 UTC+3
const nowNight = new Date("2026-07-14T22:30:00Z"); // 01:30 UTC+3 15-го

test("computeRewardPriceFromRiskUsd: long/short 1R", () => {
  // risk 10 USDT, qty 1 → 10$ на монету; entry 100 → 1R = 110 / 90
  assert.equal(computeRewardPriceFromRiskUsd(100, 10, 1, "long", 1), 110);
  assert.equal(computeRewardPriceFromRiskUsd(100, 10, 1, "short", 1), 90);
});

test("decideNightTakeProfit: дневная сделка ночью → TP 1/1 на 100%", () => {
  const decision = decideNightTakeProfit({
    side: "long",
    entryPrice: 100,
    slPrice: 90,
    riskUsd: 100, // 10$ * 10 qty
    quantity: 10,
    tpPrice: 150, // 1/5
    currentPrice: null,
    partialTpPrice: 120,
    partialTpQuantity: 7,
    partialTpFilledAt: null,
    nightTpAppliedAt: null,
    openedAt: openedDay,
    now: nowNight,
    resetHour: RESET,
    tzOffsetMinutes: TZ,
  });
  assert.equal(decision.action, "replace");
  if (decision.action === "replace") {
    assert.equal(decision.newTpPrice, 110);
    assert.equal(decision.quantity, 10);
    assert.equal(decision.cancelPartial, true);
  }
});

test("decideNightTakeProfit: после partial — TP 1/1 на остаток", () => {
  const decision = decideNightTakeProfit({
    side: "long",
    entryPrice: 100,
    slPrice: 100, // уже на входе после partial 1/2
    riskUsd: 100,
    quantity: 10,
    tpPrice: 150,
    currentPrice: null,
    partialTpPrice: 120,
    partialTpQuantity: 7,
    partialTpFilledAt: new Date(),
    nightTpAppliedAt: null,
    openedAt: openedDay,
    now: nowNight,
    resetHour: RESET,
    tzOffsetMinutes: TZ,
  });
  assert.equal(decision.action, "replace");
  if (decision.action === "replace") {
    assert.equal(decision.newTpPrice, 110);
    assert.equal(decision.quantity, 3);
    assert.equal(decision.cancelPartial, false);
  }
});

test("decideNightTakeProfit: short дневная → 1/1", () => {
  const decision = decideNightTakeProfit({
    side: "short",
    entryPrice: 100,
    slPrice: 110,
    riskUsd: 100,
    quantity: 10,
    tpPrice: 50,
    currentPrice: null,
    partialTpPrice: null,
    partialTpQuantity: null,
    partialTpFilledAt: null,
    nightTpAppliedAt: null,
    openedAt: openedDay,
    now: nowNight,
    resetHour: RESET,
    tzOffsetMinutes: TZ,
  });
  assert.equal(decision.action, "replace");
  if (decision.action === "replace") {
    assert.equal(decision.newTpPrice, 90);
    assert.equal(decision.quantity, 10);
  }
});

test("decideNightTakeProfit: уже применяли — skip", () => {
  const decision = decideNightTakeProfit({
    side: "long",
    entryPrice: 100,
    slPrice: 90,
    riskUsd: 100,
    quantity: 10,
    tpPrice: 110,
    currentPrice: null,
    partialTpPrice: null,
    partialTpQuantity: null,
    partialTpFilledAt: null,
    nightTpAppliedAt: nowNight,
    openedAt: openedDay,
    now: nowNight,
    resetHour: RESET,
    tzOffsetMinutes: TZ,
  });
  assert.equal(decision.action, "skip");
});

test("decideNightTakeProfit: открыта ночью — skip", () => {
  const decision = decideNightTakeProfit({
    side: "long",
    entryPrice: 100,
    slPrice: 90,
    riskUsd: 100,
    quantity: 10,
    tpPrice: 150,
    currentPrice: null,
    partialTpPrice: null,
    partialTpQuantity: null,
    partialTpFilledAt: null,
    nightTpAppliedAt: null,
    openedAt: new Date("2026-07-14T22:15:00Z"), // 01:15 МСК — уже ночь
    now: nowNight,
    resetHour: RESET,
    tzOffsetMinutes: TZ,
  });
  assert.equal(decision.action, "skip");
});

test("decideNightTakeProfit: ещё день — skip", () => {
  const decision = decideNightTakeProfit({
    side: "long",
    entryPrice: 100,
    slPrice: 90,
    riskUsd: 100,
    quantity: 10,
    tpPrice: 150,
    currentPrice: null,
    partialTpPrice: null,
    partialTpQuantity: null,
    partialTpFilledAt: null,
    nightTpAppliedAt: null,
    openedAt: openedDay,
    now: new Date("2026-07-14T12:00:00Z"),
    resetHour: RESET,
    tzOffsetMinutes: TZ,
  });
  assert.equal(decision.action, "skip");
});

test("decideNightTakeProfit: SL уже на 1/1 — skip", () => {
  const decision = decideNightTakeProfit({
    side: "long",
    entryPrice: 100,
    slPrice: 110,
    riskUsd: 100,
    quantity: 10,
    tpPrice: 150,
    currentPrice: null,
    partialTpPrice: 130,
    partialTpQuantity: 7,
    partialTpFilledAt: new Date(),
    nightTpAppliedAt: null,
    openedAt: openedDay,
    now: nowNight,
    resetHour: RESET,
    tzOffsetMinutes: TZ,
  });
  assert.equal(decision.action, "skip");
});

test("decideNightTakeProfit: TP уже 1/1 без висящего partial — skip", () => {
  const decision = decideNightTakeProfit({
    side: "long",
    entryPrice: 100,
    slPrice: 90,
    riskUsd: 100,
    quantity: 10,
    tpPrice: 110,
    currentPrice: null,
    partialTpPrice: null,
    partialTpQuantity: null,
    partialTpFilledAt: null,
    nightTpAppliedAt: null,
    openedAt: openedDay,
    now: nowNight,
    resetHour: RESET,
    tzOffsetMinutes: TZ,
  });
  assert.equal(decision.action, "skip");
});

test("decideNightTakeProfit: цена ещё не дошла до 1/1 → перенос TP на 1/1", () => {
  const decision = decideNightTakeProfit({
    side: "long",
    entryPrice: 100,
    slPrice: 90, // 1R = 10 пунктов, уровень 1/1 = 110
    riskUsd: 100,
    quantity: 10,
    tpPrice: 130, // план 1/3
    currentPrice: 106, // до 110 не дошли
    partialTpPrice: null,
    partialTpQuantity: null,
    partialTpFilledAt: null,
    nightTpAppliedAt: null,
    openedAt: openedDay,
    now: nowNight,
    resetHour: RESET,
    tzOffsetMinutes: TZ,
  });
  assert.equal(decision.action, "replace");
  if (decision.action === "replace") {
    assert.equal(decision.newTpPrice, 110);
  }
});

test("decideNightTakeProfit: цена уже выше 1/1 → SL на 1/1, TP не трогаем", () => {
  const decision = decideNightTakeProfit({
    side: "long",
    entryPrice: 100,
    slPrice: 90,
    riskUsd: 100,
    quantity: 10,
    tpPrice: 130, // план 1/3 остаётся
    currentPrice: 118, // уже за 110 (1/1), но до 130 не дошли
    partialTpPrice: null,
    partialTpQuantity: null,
    partialTpFilledAt: null,
    nightTpAppliedAt: null,
    openedAt: openedDay,
    now: nowNight,
    resetHour: RESET,
    tzOffsetMinutes: TZ,
  });
  assert.equal(decision.action, "moveSl");
  if (decision.action === "moveSl") {
    assert.equal(decision.newSlPrice, 110);
    assert.equal(decision.quantity, 10);
  }
});

test("decideNightTakeProfit: шорт, цена уже ниже 1/1 → SL на 1/1", () => {
  const decision = decideNightTakeProfit({
    side: "short",
    entryPrice: 100,
    slPrice: 110, // 1R = 10 пунктов, уровень 1/1 = 90
    riskUsd: 100,
    quantity: 10,
    tpPrice: 70,
    currentPrice: 85, // прошли 90 в сторону прибыли
    partialTpPrice: null,
    partialTpQuantity: null,
    partialTpFilledAt: null,
    nightTpAppliedAt: null,
    openedAt: openedDay,
    now: nowNight,
    resetHour: RESET,
    tzOffsetMinutes: TZ,
  });
  assert.equal(decision.action, "moveSl");
  if (decision.action === "moveSl") {
    assert.equal(decision.newSlPrice, 90);
  }
});

test("decideNightTakeProfit: ровно на уровне 1/1 — считаем достигнутым, SL на 1/1", () => {
  const decision = decideNightTakeProfit({
    side: "long",
    entryPrice: 100,
    slPrice: 90,
    riskUsd: 100,
    quantity: 10,
    tpPrice: 130,
    currentPrice: 110,
    partialTpPrice: null,
    partialTpQuantity: null,
    partialTpFilledAt: null,
    nightTpAppliedAt: null,
    openedAt: openedDay,
    now: nowNight,
    resetHour: RESET,
    tzOffsetMinutes: TZ,
  });
  assert.equal(decision.action, "moveSl");
});

test("decideNightTakeProfit: цена выше 1/1 и partial исполнена → SL на 1/1 на остаток", () => {
  const decision = decideNightTakeProfit({
    side: "long",
    entryPrice: 100,
    slPrice: 95, // ещё не на 1/1
    riskUsd: 100,
    quantity: 10,
    tpPrice: 130,
    currentPrice: 118,
    partialTpPrice: 120,
    partialTpQuantity: 7,
    partialTpFilledAt: new Date("2026-07-14T20:00:00Z"),
    nightTpAppliedAt: null,
    openedAt: openedDay,
    now: nowNight,
    resetHour: RESET,
    tzOffsetMinutes: TZ,
  });
  assert.equal(decision.action, "moveSl");
  if (decision.action === "moveSl") {
    assert.equal(decision.newSlPrice, 110);
    assert.equal(decision.quantity, 3); // только остаток
  }
});

test("decideNightTakeProfit: цена неизвестна → прежняя ветка (перенос TP)", () => {
  const decision = decideNightTakeProfit({
    side: "long",
    entryPrice: 100,
    slPrice: 90,
    riskUsd: 100,
    quantity: 10,
    tpPrice: 130,
    currentPrice: null,
    partialTpPrice: null,
    partialTpQuantity: null,
    partialTpFilledAt: null,
    nightTpAppliedAt: null,
    openedAt: openedDay,
    now: nowNight,
    resetHour: RESET,
    tzOffsetMinutes: TZ,
  });
  assert.equal(decision.action, "replace");
});

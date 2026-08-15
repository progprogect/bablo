import { test } from "node:test";
import assert from "node:assert/strict";
import { isProfitLockedStop, resolveTradeOutcome } from "./outcome.js";

// Лонг: вход 100, исходный SL 90 (−1R). Ночное правило подтягивает стоп на 110 (+1R).
const longEntry = { closeReason: "sl", entryPrice: 100, side: "long" };

test("стоп на 1/1 с плюсовым результатом — это тейк, а не стоп", () => {
  const trade = { ...longEntry, slPrice: 110 };
  assert.equal(isProfitLockedStop(trade, 1), true);
  assert.equal(resolveTradeOutcome(trade, 1), "tp");
});

test("исходный защитный стоп — остаётся стопом", () => {
  const trade = { ...longEntry, slPrice: 90 };
  assert.equal(isProfitLockedStop(trade, -1), false);
  assert.equal(resolveTradeOutcome(trade, -1), "sl");
});

test("стоп на входе с нулевым результатом — безубыток", () => {
  assert.equal(resolveTradeOutcome({ ...longEntry, slPrice: 100 }, 0), "be");
});

test("стоп на входе, но partial дал прибыль — тейк", () => {
  // SL на цене входа (сторона прибыли), суммарный R положительный за счёт partial
  assert.equal(resolveTradeOutcome({ ...longEntry, slPrice: 100 }, 0.7), "tp");
});

test("стоп уведён в прибыль, но закрыло в минус (проскальзывание) — стоп", () => {
  assert.equal(resolveTradeOutcome({ ...longEntry, slPrice: 110 }, -0.3), "sl");
});

test("шорт: стоп ниже входа с плюсом — тейк", () => {
  const trade = { closeReason: "sl", entryPrice: 100, slPrice: 90, side: "short" };
  assert.equal(resolveTradeOutcome(trade, 1), "tp");
});

test("шорт: стоп выше входа в минус — стоп", () => {
  const trade = { closeReason: "sl", entryPrice: 100, slPrice: 110, side: "short" };
  assert.equal(resolveTradeOutcome(trade, -1), "sl");
});

test("обычный тейк и ручное закрытие не меняются", () => {
  assert.equal(resolveTradeOutcome({ closeReason: "tp", entryPrice: 100, slPrice: 90, side: "long" }, 3), "tp");
  assert.equal(
    resolveTradeOutcome({ closeReason: "manual", entryPrice: 100, slPrice: 90, side: "long" }, 0.5),
    "other",
  );
  assert.equal(
    resolveTradeOutcome({ closeReason: "external", entryPrice: 100, slPrice: 90, side: "long" }, -0.4),
    "other",
  );
});

test("нет данных о стопе — прежнее поведение (стоп остаётся стопом)", () => {
  assert.equal(resolveTradeOutcome({ closeReason: "sl", entryPrice: null, slPrice: null, side: "long" }, 1), "sl");
});

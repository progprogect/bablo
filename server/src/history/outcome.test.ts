import { test } from "node:test";
import assert from "node:assert/strict";
import { isProfitLockedStop, resolveStatsResultR, resolveTradeOutcome } from "./outcome.js";

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

test("ручной оверрайд главнее авто-правил: стоп помечен тейком", () => {
  const trade = { closeReason: "sl", entryPrice: 100, slPrice: 90, side: "long", statsOutcome: "tp" };
  assert.equal(resolveTradeOutcome(trade, -1), "tp");
});

test("ручной оверрайд может и понизить: тейк помечен стопом", () => {
  const trade = { closeReason: "tp", entryPrice: 100, slPrice: 90, side: "long", statsOutcome: "sl" };
  assert.equal(resolveTradeOutcome(trade, 3), "sl");
});

test("ручной оверрайд перебивает и безубыток", () => {
  const trade = { closeReason: "sl", entryPrice: 100, slPrice: 100, side: "long", statsOutcome: "sl" };
  assert.equal(resolveTradeOutcome(trade, 0), "sl");
});

test("оверрайд снят (null) — снова авто", () => {
  const trade = { closeReason: "sl", entryPrice: 100, slPrice: 110, side: "long", statsOutcome: null };
  assert.equal(resolveTradeOutcome(trade, 1), "tp");
});

test("мусор в оверрайде игнорируется, работает авто", () => {
  const trade = { closeReason: "sl", entryPrice: 100, slPrice: 90, side: "long", statsOutcome: "garbage" };
  assert.equal(resolveTradeOutcome(trade, -1), "sl");
});

test("resolveStatsResultR: без ручного столбца R — фактический результат", () => {
  assert.equal(resolveStatsResultR({ statsRrPreset: null, resultR: 20 }, "tp"), 20);
  assert.equal(resolveStatsResultR({ statsRrPreset: "none", resultR: 20 }, "tp"), 20);
  assert.equal(resolveStatsResultR({ statsRrPreset: "", resultR: -1 }, "sl"), -1);
});

test("resolveStatsResultR: ручной столбец R задаёт R для статистики", () => {
  // Сделка записана как 20R (неверный риск), в админке выбран столбец 2R → в статистику +2R
  assert.equal(resolveStatsResultR({ statsRrPreset: "1/2", resultR: 20 }, "tp"), 2);
  assert.equal(resolveStatsResultR({ statsRrPreset: "1/1.5", resultR: 9 }, "tp"), 1.5);
});

test("resolveStatsResultR: знак берётся от исхода", () => {
  assert.equal(resolveStatsResultR({ statsRrPreset: "1/2", resultR: -1 }, "sl"), -2);
  // БУ и неклассифицированные — остаётся факт
  assert.equal(resolveStatsResultR({ statsRrPreset: "1/2", resultR: 0 }, "be"), 0);
  assert.equal(resolveStatsResultR({ statsRrPreset: "1/2", resultR: 0.4 }, "other"), 0.4);
});

test("resolveStatsResultR: мусорный пресет игнорируется", () => {
  assert.equal(resolveStatsResultR({ statsRrPreset: "garbage", resultR: 7 }, "tp"), 7);
});

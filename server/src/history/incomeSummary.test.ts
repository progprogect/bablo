import { test } from "node:test";
import assert from "node:assert/strict";
import { matchIncomeToTrades, matchTradeNetPnl, summarizeIncome } from "./incomeSummary.js";

test("summarizeIncome: раскладывает начисления по типам", () => {
  const summary = summarizeIncome([
    { incomeType: "TRADING_FEE", income: "-1.2", time: 1 },
    { incomeType: "COMMISSION", income: "-0.8", time: 2 },
    { incomeType: "FUNDING_FEE", income: "-0.5", time: 3 },
    { incomeType: "FUNDING_FEE", income: "0.1", time: 4 },
    { incomeType: "TRANSFER", income: "50", time: 5 },
    { incomeType: "REALIZED_PNL", income: "48.37", time: 6 },
    { incomeType: "INSURANCE_CLEAR", income: "-0.01", time: 7 },
    { incomeType: "TRADING_FEE", income: "не число", time: 8 }, // битой записи не место в суммах
  ]);
  assert.ok(Math.abs(summary.commissionUsd - -2) < 1e-9);
  assert.ok(Math.abs(summary.fundingUsd - -0.4) < 1e-9);
  assert.equal(summary.transfersUsd, 50);
  assert.equal(summary.realizedPnlUsd, 48.37);
  assert.equal(summary.otherUsd, -0.01);
  assert.equal(summary.recordCount, 8);
});

test("summarizeIncome: пустой список — нули", () => {
  const summary = summarizeIncome([]);
  assert.equal(summary.recordCount, 0);
  assert.equal(summary.commissionUsd, 0);
  assert.equal(summary.realizedPnlUsd, 0);
  assert.deepEqual(summary.byType, []);
  assert.equal(summary.firstRecordAt, null);
});

test("summarizeIncome: незнакомые вариации имён не утекают в «прочее»", () => {
  // Промах точного маппинга раньше уводил пополнение в otherUsd, и «не сходится на X»
  // оставалось необъяснённым — классификация идёт по подстроке.
  const summary = summarizeIncome([
    { incomeType: "TRANSFER_IN", income: "94.85", time: 1 },
    { incomeType: "FUNDING_FEE_V2", income: "-1.13", time: 2 },
    { incomeType: "OPEN_FEE", income: "-10", time: 3 },
  ]);
  assert.equal(summary.transfersUsd, 94.85);
  assert.equal(summary.fundingUsd, -1.13);
  assert.equal(summary.commissionUsd, -10);
  assert.equal(summary.otherUsd, 0);
});

test("summarizeIncome: сырая разбивка по типам и окно записей — для диагностики расхождений", () => {
  const summary = summarizeIncome([
    { incomeType: "REALIZED_PNL", income: "10", time: Date.UTC(2026, 7, 5) },
    { incomeType: "REALIZED_PNL", income: "8.26", time: Date.UTC(2026, 7, 20) },
    { incomeType: "TRADING_FEE", income: "-152.51", time: Date.UTC(2026, 7, 10) },
  ]);
  // Сортировка по модулю суммы: крупнейшее влияние на депозит — сверху.
  assert.deepEqual(
    summary.byType.map((entry) => [entry.type, entry.count]),
    [
      ["TRADING_FEE", 1],
      ["REALIZED_PNL", 2],
    ],
  );
  assert.equal(summary.byType[0]?.sumUsd, -152.51);
  assert.ok(Math.abs((summary.byType[1]?.sumUsd ?? 0) - 18.26) < 1e-9);
  assert.equal(summary.firstRecordAt, new Date(Date.UTC(2026, 7, 5)).toISOString());
  assert.equal(summary.lastRecordAt, new Date(Date.UTC(2026, 7, 20)).toISOString());
});

test("matchIncomeToTrades: частичная фиксация даёт две записи на одну сделку", () => {
  // Кейс от 30.08.2026: 63 записи REALIZED_PNL при 54 сделках выглядели как «часть сделок
  // не учтена», хотя это были частичные фиксации — одна сделка, два закрытия.
  const trade = {
    id: 1,
    symbol: "TIA-USDT",
    openedAt: new Date("2026-08-05T10:00:00Z"),
    closedAt: new Date("2026-08-05T14:00:00Z"),
  };
  const result = matchIncomeToTrades(
    [
      { incomeType: "REALIZED_PNL", income: "20", symbol: "TIA-USDT", time: Date.parse("2026-08-05T12:00:00Z") },
      { incomeType: "REALIZED_PNL", income: "5", symbol: "TIA-USDT", time: Date.parse("2026-08-05T14:00:00Z") },
      { incomeType: "TRADING_FEE", income: "-2", symbol: "TIA-USDT", time: Date.parse("2026-08-05T14:00:00Z") },
    ],
    [trade],
  );
  assert.equal(result.pnlByTradeId.get(1), 25);
  assert.equal(result.unmatchedCount, 0);
});

test("matchIncomeToTrades: записи вне интервалов сделок — позиции мимо приложения", () => {
  const trades = [
    {
      id: 1,
      symbol: "TIA-USDT",
      openedAt: new Date("2026-08-05T10:00:00Z"),
      closedAt: new Date("2026-08-05T11:00:00Z"),
    },
  ];
  const result = matchIncomeToTrades(
    [
      { incomeType: "REALIZED_PNL", income: "10", symbol: "TIA-USDT", time: Date.parse("2026-08-05T10:30:00Z") },
      // другой символ в то же время — приложение о такой позиции не знает
      { incomeType: "REALIZED_PNL", income: "-7", symbol: "WLD-USDT", time: Date.parse("2026-08-05T10:30:00Z") },
      // тот же символ, но задолго после закрытия
      { incomeType: "REALIZED_PNL", income: "-3", symbol: "TIA-USDT", time: Date.parse("2026-08-06T10:00:00Z") },
    ],
    trades,
  );
  assert.equal(result.pnlByTradeId.get(1), 10);
  assert.equal(result.unmatchedCount, 2);
  assert.equal(result.unmatchedPnlUsd, -10);
});

test("matchIncomeToTrades: соседние сделки по одному символу не путаются", () => {
  const trades = [
    { id: 1, symbol: "TIA-USDT", openedAt: new Date("2026-08-05T10:00:00Z"), closedAt: new Date("2026-08-05T11:00:00Z") },
    { id: 2, symbol: "TIA-USDT", openedAt: new Date("2026-08-05T12:00:00Z"), closedAt: new Date("2026-08-05T13:00:00Z") },
  ];
  const result = matchIncomeToTrades(
    [
      { incomeType: "REALIZED_PNL", income: "10", symbol: "TIA-USDT", time: Date.parse("2026-08-05T11:00:00Z") },
      { incomeType: "REALIZED_PNL", income: "-4", symbol: "TIA-USDT", time: Date.parse("2026-08-05T13:00:00Z") },
    ],
    trades,
  );
  assert.equal(result.pnlByTradeId.get(1), 10);
  assert.equal(result.pnlByTradeId.get(2), -4);
  assert.equal(result.unmatchedCount, 0);
});

// --- Полная П/У сделки (правка от 16.10.2026) ---

const MIN = 60_000;

/** Сделка: открыта в `openMin`, закрыта в `closeMin` (минуты от условного нуля). */
function tradeAt(id: number, openMin: number, closeMin: number, symbol = "TIA-USDT") {
  return {
    id,
    symbol,
    openedAt: new Date(openMin * MIN),
    closedAt: new Date(closeMin * MIN),
  };
}

test("matchTradeNetPnl: к PnL закрытия прибавляются комиссии и funding, переводы — нет", () => {
  const trade = tradeAt(1, 100, 140);
  const net = matchTradeNetPnl(
    [
      { incomeType: "TRADING_FEE", income: "-0.42", time: 100 * MIN, symbol: "TIA-USDT" },
      { incomeType: "FUNDING_FEE", income: "-0.11", time: 120 * MIN, symbol: "TIA-USDT" },
      { incomeType: "REALIZED_PNL", income: "80", time: 140 * MIN, symbol: "TIA-USDT" },
      { incomeType: "TRADING_FEE", income: "-0.47", time: 140 * MIN, symbol: "TIA-USDT" },
      // Перевод внутри интервала сделки — это не её результат, а движение денег.
      { incomeType: "TRANSFER", income: "500", time: 130 * MIN, symbol: "TIA-USDT" },
    ],
    [trade],
  );
  assert.ok(Math.abs((net.get(1) ?? 0) - 79) < 1e-9);
});

test("matchTradeNetPnl: комиссия входа не уезжает на предыдущую сделку", () => {
  // Регрессия, ради которой правило привязки строже «ближайшей по закрытию»: сделка B
  // открывается через 2 минуты после закрытия A, и её комиссия входа по прежнему
  // правилу досталась бы A — у A закрытие рядом (2 мин), у B далеко (её собственные
  // 40 минут жизни). Запись попадает в интервал B, значит она B.
  const a = tradeAt(1, 10, 50);
  const b = tradeAt(2, 52, 92);
  const net = matchTradeNetPnl(
    [{ incomeType: "TRADING_FEE", income: "-0.5", time: 52 * MIN, symbol: "TIA-USDT" }],
    [a, b],
  );
  assert.equal(net.get(1), undefined);
  assert.ok(Math.abs((net.get(2) ?? 0) - -0.5) < 1e-9);
});

test("matchTradeNetPnl: запись о закрытии с лагом биржи остаётся на своей сделке", () => {
  // Обратная сторона того же правила: PnL закрытия приходит через 2 минуты после
  // закрытия — внутрь интервала он уже не попадает, но по краю ближе всего именно к A.
  const a = tradeAt(1, 10, 50);
  const b = tradeAt(2, 70, 110);
  const net = matchTradeNetPnl(
    [{ incomeType: "REALIZED_PNL", income: "12.5", time: 52 * MIN, symbol: "TIA-USDT" }],
    [a, b],
  );
  assert.ok(Math.abs((net.get(1) ?? 0) - 12.5) < 1e-9);
  assert.equal(net.get(2), undefined);
});

test("matchTradeNetPnl: чужой символ и незакрытые сделки не участвуют", () => {
  const tia = tradeAt(1, 100, 140, "TIA-USDT");
  const open = { id: 2, symbol: "TAO-USDT", openedAt: new Date(100 * MIN), closedAt: null };
  const net = matchTradeNetPnl(
    [
      { incomeType: "REALIZED_PNL", income: "5", time: 120 * MIN, symbol: "WLD-USDT" },
      { incomeType: "REALIZED_PNL", income: "7", time: 120 * MIN, symbol: "TAO-USDT" },
    ],
    [tia, open],
  );
  assert.equal(net.size, 0);
});

test("matchTradeNetPnl: битая сумма не ломает итог", () => {
  const trade = tradeAt(1, 100, 140);
  const net = matchTradeNetPnl(
    [
      { incomeType: "REALIZED_PNL", income: "не число", time: 140 * MIN, symbol: "TIA-USDT" },
      { incomeType: "REALIZED_PNL", income: "3", time: 140 * MIN, symbol: "TIA-USDT" },
    ],
    [trade],
  );
  assert.equal(net.get(1), 3);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeIncome } from "./incomeSummary.js";

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

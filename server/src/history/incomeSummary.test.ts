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
});

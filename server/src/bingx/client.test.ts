import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSwapBalanceResponse } from "../bingx/client.js";

describe("normalizeSwapBalanceResponse", () => {
  it("v3: массив записей — берёт USDT", () => {
    const result = normalizeSwapBalanceResponse([
      {
        asset: "USDT",
        balance: "194.8212",
        equity: "196.7431",
        availableMargin: "193.7609",
        unrealizedProfit: "1.9219",
      },
    ]);
    assert.equal(result.equity, "196.7431");
    assert.equal(result.balance, "194.8212");
  });

  it("v2: обёртка { balance }", () => {
    const result = normalizeSwapBalanceResponse({
      balance: {
        asset: "USDT",
        balance: "100.0000",
        equity: "100.0000",
        availableMargin: "100.0000",
        unrealizedProfit: "0.0000",
      },
    });
    assert.equal(result.equity, "100.0000");
  });
});

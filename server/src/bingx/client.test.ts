import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getOrderHistory, getOrderStatus, normalizeSwapBalanceResponse } from "../bingx/client.js";

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

describe("getOrderStatus", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("распаковывает ответ BingX { data: { order: {...} } } — раньше .status всегда был undefined", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            order: {
              orderId: "123",
              symbol: "TIA-USDT",
              status: "FILLED",
              avgPrice: "5.4321",
              profit: "12.34",
            },
          },
        }),
        { status: 200 },
      )) as typeof fetch;

    const status = await getOrderStatus({ apiKey: "k", secretKey: "s" }, "TIA-USDT", "123");
    assert.equal(status.status, "FILLED");
    assert.equal(status.avgPrice, "5.4321");
    assert.equal(status.profit, "12.34");
  });
});

describe("getOrderHistory", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("распаковывает ответ BingX { data: { orders: [...] } } — список исторических ордеров", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            orders: [
              { orderId: "111", symbol: "TIA-USDT", status: "CANCELLED", avgPrice: "0" },
              { orderId: "222", symbol: "TIA-USDT", status: "FILLED", avgPrice: "5.4321", profit: "12.34" },
            ],
          },
        }),
        { status: 200 },
      )) as typeof fetch;

    const orders = await getOrderHistory({ apiKey: "k", secretKey: "s" }, "TIA-USDT", 0, Date.now());
    assert.equal(orders.length, 2);
    assert.equal(orders[1]?.status, "FILLED");
    assert.equal(orders[1]?.orderId, "222");
  });
});

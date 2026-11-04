import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BingXApiError, getLatestPrice, getOrderHistory, getOrderStatus, normalizeSwapBalanceResponse } from "../bingx/client.js";

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

describe("разбор ответа BingX", () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  it("не-JSON ответ: понятная ошибка со статусом, а не SyntaxError «Unexpected token <»", async () => {
    console.error = () => {};
    globalThis.fetch = (async () =>
      new Response("<html><body>403 Forbidden</body></html>", { status: 403 })) as typeof fetch;

    const error = await getLatestPrice("TIA-USDT").then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error instanceof BingXApiError, "ожидали BingXApiError");
    assert.equal(error.code, -1);
    assert.match(error.message, /^HTTP 403, ответ не JSON: <html>/);
  });

  it("пустое тело: в сообщении видно, что ответа не было", async () => {
    console.error = () => {};
    globalThis.fetch = (async () => new Response("", { status: 502 })) as typeof fetch;

    const error = await getLatestPrice("TIA-USDT").then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error instanceof BingXApiError);
    assert.equal(error.message, "HTTP 502, ответ не JSON: пустой ответ");
  });

  it("ненулевой code: причина отказа уходит в лог вместе с путём", async () => {
    const lines: string[] = [];
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 100410, msg: "rate limited", data: null }), {
        status: 200,
      })) as typeof fetch;

    const error = await getLatestPrice("TIA-USDT").then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error instanceof BingXApiError);
    assert.equal(error.code, 100410);
    assert.equal(error.message, "rate limited");
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "[bingx] GET /swap/v2/quote/price → code 100410: rate limited");
  });
});

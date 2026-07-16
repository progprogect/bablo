import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { findFilledSlOrTp } from "./reconcile.js";
import type { Trade } from "../db/repositories/trades.js";

function fakeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 1,
    symbol: "TIA-USDT",
    side: "long",
    status: "active",
    openedAt: new Date("2026-07-16T10:00:00Z"),
    entryPrice: "5",
    ...overrides,
  } as unknown as Trade;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("findFilledSlOrTp", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("находит FILLED SL через историю ордеров, даже если точечный лукап вернул бы пусто", async () => {
    let call = 0;
    globalThis.fetch = (async (url: string | URL) => {
      call += 1;
      // Первый и единственный ожидаемый запрос — allOrders (история). Точечный
      // getOrderStatus не должен вызываться, если ордер уже нашёлся в истории.
      assert.match(String(url), /allOrders/);
      return jsonResponse({
        code: 0,
        msg: "",
        data: {
          orders: [
            { orderId: "sl-1", symbol: "TIA-USDT", status: "FILLED", avgPrice: "4.5", profit: "-10" },
            { orderId: "tp-1", symbol: "TIA-USDT", status: "CANCELLED", avgPrice: "0" },
          ],
        },
      });
    }) as typeof fetch;

    const result = await findFilledSlOrTp(
      { apiKey: "k", secretKey: "s" },
      fakeTrade(),
      { sl: "sl-1", tp: "tp-1" },
    );
    assert.equal(result?.key, "sl");
    assert.equal(result?.order.avgPrice, "4.5");
    assert.equal(call, 1);
  });

  it("падает обратно на точечный getOrderStatus, если ордер не нашёлся в истории", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("allOrders")) {
        return jsonResponse({ code: 0, msg: "", data: { orders: [] } });
      }
      return jsonResponse({
        code: 0,
        msg: "",
        data: { order: { orderId: "sl-1", symbol: "TIA-USDT", status: "FILLED", avgPrice: "4.5" } },
      });
    }) as typeof fetch;

    const result = await findFilledSlOrTp(
      { apiKey: "k", secretKey: "s" },
      fakeTrade(),
      { sl: "sl-1", tp: "tp-1" },
    );
    assert.equal(result?.key, "sl");
  });

  it("возвращает null, если ни один ордер не FILLED ни в истории, ни точечно", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("allOrders")) {
        return jsonResponse({ code: 0, msg: "", data: { orders: [] } });
      }
      return jsonResponse({
        code: 0,
        msg: "",
        data: { order: { orderId: "x", symbol: "TIA-USDT", status: "NEW", avgPrice: "0" } },
      });
    }) as typeof fetch;

    const result = await findFilledSlOrTp(
      { apiKey: "k", secretKey: "s" },
      fakeTrade(),
      { sl: "sl-1", tp: "tp-1" },
    );
    assert.equal(result, null);
  });

  it("null, если у сделки нет ни sl, ни tp orderId", async () => {
    const result = await findFilledSlOrTp({ apiKey: "k", secretKey: "s" }, fakeTrade(), {});
    assert.equal(result, null);
  });
});

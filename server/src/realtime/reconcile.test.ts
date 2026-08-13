import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { computeResult } from "./reconcile.js";
import { findFilledSlOrTp, resolveCloseFromFilledOrder } from "./filledOrder.js";
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

  it("находит FILLED SL по triggerOrderId — реальное поведение BingX: исходный условный ордер остаётся CANCELLED, срабатывание создаёт новый ордер с другим orderId", async () => {
    let call = 0;
    globalThis.fetch = (async (url: string | URL) => {
      call += 1;
      assert.match(String(url), /allOrders/);
      return jsonResponse({
        code: 0,
        msg: "",
        data: {
          orders: [
            // Исходный SL-ордер — навсегда CANCELLED, даже если реально сработал.
            { orderId: "sl-1", symbol: "TIA-USDT", status: "CANCELLED", avgPrice: "0" },
            // BingX создаёт НОВЫЙ ордер при срабатывании: другой orderId, но
            // triggerOrderId указывает на исходный условный ордер.
            {
              orderId: "sl-1-executed",
              symbol: "TIA-USDT",
              status: "FILLED",
              avgPrice: "4.5",
              profit: "-10",
              triggerOrderId: "sl-1",
            },
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

describe("computeResult с частичной фиксацией", () => {
  it("складывает PnL partial (70% @ 1/3) и остатка (30% @ 1/5) — иначе дневной +3R не сработал бы", () => {
    // entry=100, sl=95 → risk distance=5, riskUsd=5*10=50
    // partial 7 @ 115 (3R): pnl = 15*7 = 105 → 2.1R
    // remainder rp = 25*3 = 75 → 1.5R
    // total = 180 / 50 = 3.6R
    const trade = fakeTrade({
      entryPrice: "100",
      quantity: "10",
      riskUsd: "50",
      side: "long",
      partialTpFilledAt: new Date("2026-07-22T10:00:00Z"),
      partialTpQuantity: "7",
      partialTpFillPrice: "115",
    });
    const { resultR } = computeResult(trade, 125, 75);
    assert.ok(Math.abs(resultR - 3.6) < 1e-9, `expected 3.6, got ${resultR}`);
  });

  it("без partial использует только realizedProfit финального ордера", () => {
    const trade = fakeTrade({
      entryPrice: "100",
      quantity: "10",
      riskUsd: "50",
      side: "long",
    });
    // pnl 150 / risk 50 = 3R
    const { resultR } = computeResult(trade, 115, 150);
    assert.equal(resultR, 3);
  });

  it("rp=0 при реальном убытке по цене — не доверяем нулю BingX, считаем по closePrice", () => {
    // STOP_MARKET с проскальзыванием: биржа иногда шлёт rp=0, ap=реальная цена
    const trade = fakeTrade({
      entryPrice: "100",
      quantity: "10",
      riskUsd: "50",
      side: "long",
    });
    // close 90 → −10*10 = −100$ → −2R; rp=0 от биржи
    const { resultR } = computeResult(trade, 90, 0);
    assert.equal(resultR, -2);
  });

  it("rp=0 и close≈entry — оставляем ноль (реальный БУ)", () => {
    const trade = fakeTrade({
      entryPrice: "100",
      quantity: "10",
      riskUsd: "50",
      side: "long",
    });
    const { resultR } = computeResult(trade, 100, 0);
    assert.equal(resultR, 0);
  });
});

describe("resolveCloseFromFilledOrder", () => {
  it("исполнившийся ночной TP 1/1 — это тейк с ценой fill, а не external", () => {
    // Ночное поджатие переписывает bingxOrderIds.tp на новый ордер (trades/service.ts),
    // поэтому найденный по нему fill должен давать closeReason "tp" — сделка попадает
    // в тейки статистики и дневных лимитов (docs/PROJECT.md).
    const trade = fakeTrade({ entryPrice: "100", slPrice: "95", tpPrice: "105" });
    const resolved = resolveCloseFromFilledOrder(trade, {
      key: "tp",
      order: { avgPrice: "105.2", profit: "50" } as never,
    });
    assert.equal(resolved.closeReason, "tp");
    assert.equal(resolved.closePrice, 105.2);
    assert.equal(resolved.realizedProfit, 50);
  });

  it("avgPrice=0 от BingX — берём сохранённую цену сработавшей стороны, а не вход", () => {
    const trade = fakeTrade({ entryPrice: "100", slPrice: "95", tpPrice: "105" });
    const bySl = resolveCloseFromFilledOrder(trade, {
      key: "sl",
      order: { avgPrice: "0" } as never,
    });
    assert.equal(bySl.closePrice, 95);
    assert.equal(bySl.realizedProfit, null);

    const byTp = resolveCloseFromFilledOrder(trade, {
      key: "tp",
      order: {} as never,
    });
    assert.equal(byTp.closePrice, 105);
  });

  it("нет ни fill-цены, ни сохранённой цены стороны — откат на цену входа", () => {
    const trade = fakeTrade({ entryPrice: "100", slPrice: null, tpPrice: null });
    const resolved = resolveCloseFromFilledOrder(trade, { key: "sl", order: {} as never });
    assert.equal(resolved.closePrice, 100);
  });
});

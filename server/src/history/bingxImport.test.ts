import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTradesFromOrders, toImportOrder, type ImportOrder } from "./bingxImport.js";

const T0 = Date.parse("2026-10-20T10:00:00Z");
const minute = 60_000;

function order(partial: Partial<ImportOrder> & { orderId: string }): ImportOrder {
  return {
    symbol: "TIA-USDT",
    side: "BUY",
    type: "MARKET",
    status: "FILLED",
    avgPrice: 100,
    executedQty: 10,
    stopPrice: null,
    profit: null,
    time: T0,
    updateTime: T0,
    triggerOrderId: null,
    ...partial,
  };
}

test("лонг по тейку: вход, стоп-ордер, сработавший тейк", () => {
  const orders = [
    order({ orderId: "1", side: "BUY", avgPrice: 100, executedQty: 10, time: T0, updateTime: T0 }),
    // Стоп выставлен и остался CANCELLED — по нему считается риск сделки.
    order({ orderId: "2", type: "STOP_MARKET", status: "CANCELLED", side: "SELL", stopPrice: 98, executedQty: 0, avgPrice: 0, time: T0 + minute }),
    order({ orderId: "3", type: "TAKE_PROFIT_MARKET", status: "CANCELLED", side: "SELL", stopPrice: 104, executedQty: 0, avgPrice: 0, time: T0 + minute }),
    // Срабатывание тейка: новый ордер со ссылкой на исходный условный.
    order({ orderId: "4", side: "SELL", avgPrice: 104, executedQty: 10, profit: 40, triggerOrderId: "3", time: T0 + 30 * minute, updateTime: T0 + 30 * minute }),
  ];
  const { trades, skipped } = buildTradesFromOrders(orders);
  assert.equal(skipped.length, 0);
  assert.equal(trades.length, 1);
  const trade = trades[0]!;
  assert.equal(trade.side, "long");
  assert.equal(trade.entryPrice, 100);
  assert.equal(trade.closePrice, 104);
  assert.equal(trade.slPrice, 98);
  assert.equal(trade.closeReason, "tp");
  assert.equal(trade.riskUsd, 20); // |100 − 98| × 10
  assert.equal(trade.resultR, 2); // +40 USDT при риске 20
  assert.equal(trade.realizedPnlUsd, 40);
  assert.deepEqual(trade.orderIds, { entry: ["1"], exit: ["4"] });
});

test("шорт по стопу: сторона и знак R считаются верно", () => {
  const orders = [
    order({ orderId: "1", side: "SELL", avgPrice: 100, executedQty: 5 }),
    order({ orderId: "2", type: "STOP_MARKET", status: "CANCELLED", side: "BUY", stopPrice: 102, executedQty: 0, avgPrice: 0, time: T0 + minute }),
    order({ orderId: "3", side: "BUY", avgPrice: 102, executedQty: 5, profit: -10, triggerOrderId: "2", time: T0 + 20 * minute, updateTime: T0 + 20 * minute }),
  ];
  const { trades } = buildTradesFromOrders(orders);
  assert.equal(trades.length, 1);
  const trade = trades[0]!;
  assert.equal(trade.side, "short");
  assert.equal(trade.closeReason, "sl");
  assert.equal(trade.riskUsd, 10); // |100 − 102| × 5
  assert.equal(trade.resultR, -1);
});

test("закрытие частями: сделка собирается из двух исполнений", () => {
  const orders = [
    order({ orderId: "1", side: "BUY", avgPrice: 100, executedQty: 10 }),
    order({ orderId: "2", type: "STOP_MARKET", status: "CANCELLED", side: "SELL", stopPrice: 95, executedQty: 0, avgPrice: 0, time: T0 + minute }),
    order({ orderId: "3", side: "SELL", avgPrice: 105, executedQty: 7, profit: 35, time: T0 + 10 * minute, updateTime: T0 + 10 * minute }),
    order({ orderId: "4", side: "SELL", avgPrice: 110, executedQty: 3, profit: 30, time: T0 + 20 * minute, updateTime: T0 + 20 * minute }),
  ];
  const { trades } = buildTradesFromOrders(orders);
  assert.equal(trades.length, 1);
  const trade = trades[0]!;
  assert.equal(trade.quantity, 10);
  assert.equal(trade.realizedPnlUsd, 65);
  assert.equal(trade.riskUsd, 50); // |100 − 95| × 10
  assert.equal(trade.resultR, 1.3);
  assert.deepEqual(trade.orderIds.exit, ["3", "4"]);
  // Цена закрытия — средневзвешенная по объёму: (105×7 + 110×3) / 10.
  assert.equal(trade.closePrice, 106.5);
});

test("две сделки подряд по одному активу не склеиваются", () => {
  const orders = [
    order({ orderId: "1", side: "BUY", avgPrice: 100, executedQty: 10 }),
    order({ orderId: "2", side: "SELL", avgPrice: 103, executedQty: 10, profit: 30, time: T0 + 5 * minute, updateTime: T0 + 5 * minute }),
    order({ orderId: "3", side: "BUY", avgPrice: 110, executedQty: 4, time: T0 + 60 * minute, updateTime: T0 + 60 * minute }),
    order({ orderId: "4", side: "SELL", avgPrice: 108, executedQty: 4, profit: -8, time: T0 + 90 * minute, updateTime: T0 + 90 * minute }),
  ];
  const { trades } = buildTradesFromOrders(orders);
  assert.equal(trades.length, 2);
  assert.equal(trades[0]?.entryPrice, 100);
  assert.equal(trades[1]?.entryPrice, 110);
  assert.equal(trades[1]?.quantity, 4);
});

test("без стоп-ордера сделка импортируется, но без R", () => {
  const orders = [
    order({ orderId: "1", side: "BUY", avgPrice: 100, executedQty: 10 }),
    order({ orderId: "2", side: "SELL", avgPrice: 101, executedQty: 10, profit: 10, time: T0 + 5 * minute, updateTime: T0 + 5 * minute }),
  ];
  const { trades } = buildTradesFromOrders(orders);
  assert.equal(trades.length, 1);
  assert.equal(trades[0]?.slPrice, null);
  assert.equal(trades[0]?.riskUsd, null);
  assert.equal(trades[0]?.resultR, null);
  assert.equal(trades[0]?.realizedPnlUsd, 10);
  assert.equal(trades[0]?.closeReason, "manual");
});

test("стоп по прибыльную сторону от входа риском не считается", () => {
  // Такой «стоп» — это подтянутый в прибыль стоп уже другой позиции или мусор.
  const orders = [
    order({ orderId: "1", side: "BUY", avgPrice: 100, executedQty: 10 }),
    order({ orderId: "2", type: "STOP_MARKET", status: "CANCELLED", side: "SELL", stopPrice: 105, executedQty: 0, avgPrice: 0, time: T0 + minute }),
    order({ orderId: "3", side: "SELL", avgPrice: 106, executedQty: 10, profit: 60, time: T0 + 10 * minute, updateTime: T0 + 10 * minute }),
  ];
  const { trades } = buildTradesFromOrders(orders);
  assert.equal(trades[0]?.slPrice, null);
  assert.equal(trades[0]?.resultR, null);
});

test("позиция, открытая до начала окна, не превращается в сделку с выдуманным входом", () => {
  // В окно попало только закрытие: вход остался за его пределами.
  const orders = [
    order({ orderId: "9", side: "SELL", avgPrice: 104, executedQty: 10, profit: 40, time: T0, updateTime: T0 }),
  ];
  const { trades, skipped } = buildTradesFromOrders(orders);
  // Первое исполнение считается входом — позиция остаётся открытой и в сделки не попадает.
  assert.equal(trades.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0]?.reason ?? "", /ещё открыта/);
});

test("нулевой profit при реально ушедшей цене — считаем по ценам (баг BingX rp=0)", () => {
  const orders = [
    order({ orderId: "1", side: "BUY", avgPrice: 100, executedQty: 10 }),
    order({ orderId: "2", type: "STOP_MARKET", status: "CANCELLED", side: "SELL", stopPrice: 98, executedQty: 0, avgPrice: 0, time: T0 + minute }),
    order({ orderId: "3", side: "SELL", avgPrice: 98, executedQty: 10, profit: 0, triggerOrderId: "2", time: T0 + 10 * minute, updateTime: T0 + 10 * minute }),
  ];
  const { trades } = buildTradesFromOrders(orders);
  assert.equal(trades[0]?.realizedPnlUsd, -20);
  assert.equal(trades[0]?.resultR, -1);
});

test("доливка в позицию: средняя цена входа по объёму", () => {
  const orders = [
    order({ orderId: "1", side: "BUY", avgPrice: 100, executedQty: 10 }),
    order({ orderId: "2", side: "BUY", avgPrice: 110, executedQty: 10, time: T0 + 2 * minute, updateTime: T0 + 2 * minute }),
    order({ orderId: "3", side: "SELL", avgPrice: 120, executedQty: 20, profit: 300, time: T0 + 30 * minute, updateTime: T0 + 30 * minute }),
  ];
  const { trades } = buildTradesFromOrders(orders);
  assert.equal(trades.length, 1);
  assert.equal(trades[0]?.entryPrice, 105);
  assert.equal(trades[0]?.quantity, 20);
  assert.deepEqual(trades[0]?.orderIds.entry, ["1", "2"]);
});

test("неисполненные и отменённые ордера в сделки не попадают", () => {
  const orders = [
    order({ orderId: "1", status: "NEW", executedQty: 0, avgPrice: 0 }),
    order({ orderId: "2", status: "CANCELLED", executedQty: 0, avgPrice: 0 }),
  ];
  const { trades, skipped } = buildTradesFromOrders(orders);
  assert.deepEqual(trades, []);
  assert.deepEqual(skipped, []);
});

test("toImportOrder: строки BingX приводятся к числам, пустой triggerOrderId — null", () => {
  const parsed = toImportOrder({
    orderId: 123,
    symbol: "TAO-USDT",
    side: "BUY",
    type: "MARKET",
    status: "FILLED",
    avgPrice: "250.5",
    executedQty: "0.4",
    stopPrice: "",
    profit: "1.25",
    time: 1762000000000,
    updateTime: 1762000060000,
    triggerOrderId: "0",
  });
  assert.ok(parsed);
  assert.equal(parsed.orderId, "123");
  assert.equal(parsed.avgPrice, 250.5);
  assert.equal(parsed.executedQty, 0.4);
  assert.equal(parsed.stopPrice, null);
  assert.equal(parsed.profit, 1.25);
  assert.equal(parsed.triggerOrderId, null);
  assert.equal(toImportOrder({ symbol: "TAO-USDT" }), null);
});

import { cancelOrder, getLatestPrice, getOrderStatus } from "../bingx/client.js";
import { getActiveTrade, updateTrade, type Trade } from "../db/repositories/trades.js";
import { getBingxCredentials } from "../db/repositories/settings.js";
import { eventBus } from "../events/bus.js";
import { computeResultFromPrices, type TradeSide } from "../trades/math.js";
import { finalizeTradeClose } from "../trades/service.js";
import type { OrderTradeUpdate } from "./accountStream.js";

function computeResult(
  trade: Trade,
  closePrice: number,
  realizedProfit: number | null,
): { resultR: number; resultPct: number } {
  const entryPrice = Number(trade.entryPrice);
  const quantity = Number(trade.quantity);
  const riskUsd = Number(trade.riskUsd) || 0;
  const side = trade.side as TradeSide;

  if (realizedProfit !== null && Number.isFinite(realizedProfit)) {
    const resultR = riskUsd > 0 ? realizedProfit / riskUsd : 0;
    const resultPct = entryPrice > 0 && quantity > 0 ? (realizedProfit / (entryPrice * quantity)) * 100 : 0;
    return { resultR, resultPct };
  }

  return computeResultFromPrices(side, entryPrice, closePrice, quantity, riskUsd);
}

/**
 * Основной путь детекции закрытия по SL/TP: ORDER_TRADE_UPDATE со статусом "FILLED"
 * по одному из сохранённых orderId (sl/tp) активной сделки. Даёт точную цену исполнения
 * (ap) и реализованный PnL (rp) прямо из события — без дополнительных REST-запросов.
 */
export async function reconcileOrderUpdate(order: OrderTradeUpdate): Promise<void> {
  if (order.X !== "FILLED") return;

  const trade = await getActiveTrade();
  if (!trade || trade.symbol !== order.s) return;

  const orderIds = (trade.bingxOrderIds as Record<string, string | number> | null) ?? {};
  const isSl = orderIds.sl !== undefined && String(orderIds.sl) === String(order.i);
  const isTp = orderIds.tp !== undefined && String(orderIds.tp) === String(order.i);
  const isPartialTp = orderIds.partialTp !== undefined && String(orderIds.partialTp) === String(order.i);
  if (!isSl && !isTp && !isPartialTp) return;

  // Частичная фиксация закрывает только часть объёма — сделка остаётся активной,
  // SL и основной TP на остаток продолжают действовать (см. docs/PROJECT.md).
  if (isPartialTp) {
    const fillPrice = order.ap && Number(order.ap) > 0 ? Number(order.ap) : Number(trade.partialTpPrice) || null;
    await updateTrade(trade.id, {
      partialTpFilledAt: new Date(),
      ...(fillPrice !== null ? { partialTpFillPrice: fillPrice } : {}),
    }).catch(() => {
      // best-effort — статус частичной фиксации не критичен для риск-движка
    });
    eventBus.emitTyped("refresh", { reason: "trade.partialFilled" });
    return;
  }

  const fallbackPrice = Number(isSl ? trade.slPrice : trade.tpPrice) || Number(trade.entryPrice);
  const closePrice = order.ap && Number(order.ap) > 0 ? Number(order.ap) : fallbackPrice;
  const realizedProfit = order.rp !== undefined ? Number(order.rp) : null;
  const { resultR, resultPct } = computeResult(trade, closePrice, realizedProfit);

  const credentials = await getBingxCredentials();
  const otherOrderId = orderIds[isSl ? "tp" : "sl"];
  if (credentials) {
    // Отменяем всё, что могло остаться висеть на бирже: другую сторону (SL/TP) и
    // ордер частичной фиксации, если он ещё не сработал (например, цена ушла прямо к SL).
    for (const pendingId of [otherOrderId, orderIds.partialTp]) {
      if (pendingId === undefined) continue;
      await cancelOrder(credentials, trade.symbol, pendingId).catch(() => {
        // ордер мог уже исполниться/отмениться сам — ожидаемо, не критично
      });
    }
  }

  await finalizeTradeClose(trade.id, {
    closeReason: isSl ? "sl" : "tp",
    closePrice,
    resultR,
    resultPct,
  });
}

/**
 * Резервный путь (см. docs/ARCHITECTURE.md — известный нюанс BingX: срабатывание
 * STOP_MARKET/TAKE_PROFIT_MARKET не всегда приходит в ORDER_TRADE_UPDATE). Триггерится
 * из ACCOUNT_UPDATE, когда позиция по символу активной сделки обнулилась. Одиночная
 * (не циклическая) REST-сверка статусов SL/TP-ордеров — чтобы понять, что сработало.
 */
export async function reconcilePositionFlat(symbol: string): Promise<void> {
  const trade = await getActiveTrade();
  if (!trade || trade.symbol !== symbol) return;

  const credentials = await getBingxCredentials();
  if (!credentials) return;

  const orderIds = (trade.bingxOrderIds as Record<string, string | number> | null) ?? {};
  const [slStatus, tpStatus] = await Promise.all([
    orderIds.sl !== undefined
      ? getOrderStatus(credentials, symbol, orderIds.sl).catch(() => null)
      : Promise.resolve(null),
    orderIds.tp !== undefined
      ? getOrderStatus(credentials, symbol, orderIds.tp).catch(() => null)
      : Promise.resolve(null),
  ]);

  const filled =
    slStatus?.status === "FILLED"
      ? { key: "sl" as const, status: slStatus }
      : tpStatus?.status === "FILLED"
        ? { key: "tp" as const, status: tpStatus }
        : null;

  let closePrice: number;
  let realizedProfit: number | null = null;
  let closeReason: string;

  if (filled) {
    closeReason = filled.key;
    closePrice = Number(filled.status.avgPrice) || Number(trade.entryPrice);
    realizedProfit = filled.status.profit !== undefined ? Number(filled.status.profit) : null;
  } else {
    // Ни один из наших ордеров не FILLED (например, позицию закрыли вручную в приложении
    // BingX) — точную цену не знаем, берём текущую рыночную как приближение.
    closeReason = "external";
    closePrice = await getLatestPrice(symbol).catch(() => Number(trade.entryPrice));
  }

  const { resultR, resultPct } = computeResult(trade, closePrice, realizedProfit);

  const otherOrderId = orderIds[filled?.key === "sl" ? "tp" : "sl"];
  for (const pendingId of [otherOrderId, orderIds.partialTp]) {
    if (pendingId === undefined) continue;
    await cancelOrder(credentials, trade.symbol, pendingId).catch(() => {
      // ордер мог уже исполниться/отмениться сам — ожидаемо, не критично
    });
  }

  await finalizeTradeClose(trade.id, { closeReason, closePrice, resultR, resultPct });
}

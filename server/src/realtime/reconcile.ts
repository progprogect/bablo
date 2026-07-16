import {
  cancelOrder,
  getLatestPrice,
  getOrderHistory,
  getOrderStatus,
  type BingXCredentials,
  type BingXOrderStatus,
} from "../bingx/client.js";
import { getActiveTrade, updateTrade, type Trade } from "../db/repositories/trades.js";
import { getBingxCredentials } from "../db/repositories/settings.js";
import { eventBus } from "../events/bus.js";
import { computeResultFromPrices, type TradeSide } from "../trades/math.js";
import { finalizeTradeClose } from "../trades/service.js";
import type { OrderTradeUpdate } from "./accountStream.js";

const MAX_HISTORY_RANGE_MS = 7 * 24 * 60 * 60 * 1000 - 60_000; // BingX: не больше 7 дней

/**
 * Ищет, какой из сохранённых SL/TP-ордеров сделки реально исполнился (FILLED).
 * Экспортируется также для trades/reclassify.ts — та же логика нужна для повторной
 * сверки уже закрытых "external"-сделок.
 *
 * Сначала сканирует историю ордеров символа (getOrderHistory) — это надёжнее для
 * STOP_MARKET/TAKE_PROFIT_MARKET: BingX иногда не находит условный ордер по orderId
 * через точечный лукап после срабатывания (см. bingx/client.ts). Точечный getOrderStatus
 * — запасной путь, если ордер почему-то не попал в список истории (например, лимит в
 * 500 записей на очень активном символе).
 */
export async function findFilledSlOrTp(
  credentials: BingXCredentials,
  trade: Trade,
  orderIds: Record<string, string | number>,
): Promise<{ key: "sl" | "tp"; order: BingXOrderStatus } | null> {
  if (orderIds.sl === undefined && orderIds.tp === undefined) return null;

  const now = Date.now();
  const openedAtMs = trade.openedAt ? new Date(trade.openedAt).getTime() : now;
  const startTime = Math.max(openedAtMs, now - MAX_HISTORY_RANGE_MS);
  const history = await getOrderHistory(credentials, trade.symbol, startTime, now).catch(() => []);

  const findInHistory = (id: string | number | undefined) =>
    id === undefined ? undefined : history.find((o) => String(o.orderId) === String(id));

  const slFromHistory = findInHistory(orderIds.sl);
  if (slFromHistory?.status === "FILLED") return { key: "sl", order: slFromHistory };
  const tpFromHistory = findInHistory(orderIds.tp);
  if (tpFromHistory?.status === "FILLED") return { key: "tp", order: tpFromHistory };

  const [slStatus, tpStatus] = await Promise.all([
    orderIds.sl !== undefined ? getOrderStatus(credentials, trade.symbol, orderIds.sl).catch(() => null) : null,
    orderIds.tp !== undefined ? getOrderStatus(credentials, trade.symbol, orderIds.tp).catch(() => null) : null,
  ]);
  if (slStatus?.status === "FILLED") return { key: "sl", order: slStatus };
  if (tpStatus?.status === "FILLED") return { key: "tp", order: tpStatus };

  return null;
}

/** Экспортируется также для backfill/reclassify.ts — пересчёт результата для уже закрытых сделок. */
export function computeResult(
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
  const filled = await findFilledSlOrTp(credentials, trade, orderIds);

  let closePrice: number;
  let realizedProfit: number | null = null;
  let closeReason: string;

  if (filled) {
    closeReason = filled.key;
    closePrice = Number(filled.order.avgPrice) || Number(trade.entryPrice);
    realizedProfit = filled.order.profit !== undefined ? Number(filled.order.profit) : null;
  } else {
    // Ни один из наших ордеров не FILLED (например, позицию закрыли вручную в приложении
    // BingX) — точную цену не знаем, берём текущую рыночную как приближение.
    closeReason = "external";
    closePrice = await getLatestPrice(symbol).catch(() => Number(trade.entryPrice));
  }

  const { resultR, resultPct } = computeResult(trade, closePrice, realizedProfit);

  // Если знаем, что сработало — отменяем только другую сторону. Если не знаем (external,
  // например позицию закрыли вручную на бирже) — отменяем обе, чтобы не оставить висящий
  // reduceOnly-ордер, который может задеть будущую сделку по этому же символу.
  const idsToCancel = filled
    ? [orderIds[filled.key === "sl" ? "tp" : "sl"], orderIds.partialTp]
    : [orderIds.sl, orderIds.tp, orderIds.partialTp];
  for (const pendingId of idsToCancel) {
    if (pendingId === undefined) continue;
    await cancelOrder(credentials, trade.symbol, pendingId).catch(() => {
      // ордер мог уже исполниться/отмениться сам — ожидаемо, не критично
    });
  }

  await finalizeTradeClose(trade.id, { closeReason, closePrice, resultR, resultPct });
}

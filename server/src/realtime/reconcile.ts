import { cancelOrder, getLatestPrice } from "../bingx/client.js";
import { getActiveTrade, updateTrade } from "../db/repositories/trades.js";
import { getBingxCredentials } from "../db/repositories/settings.js";
import { eventBus } from "../events/bus.js";
import { computeResult } from "../trades/result.js";
import { finalizeTradeClose, moveStopLossAfterPartial } from "../trades/service.js";
import type { OrderTradeUpdate } from "./accountStream.js";
import { findFilledSlOrTp, resolveCloseFromFilledOrder } from "./filledOrder.js";

export { computeResult } from "../trades/result.js";

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
  // основной TP на остаток продолжает действовать. Если partial была на ≈1/2 или ≈1/3 —
  // подтягиваем SL (ход остатка ≤ 2R: 1/2→вход, 1/3→1/1; docs/PROJECT.md).
  if (isPartialTp) {
    const fillPrice = order.ap && Number(order.ap) > 0 ? Number(order.ap) : Number(trade.partialTpPrice) || null;
    await updateTrade(trade.id, {
      partialTpFilledAt: new Date(),
      ...(fillPrice !== null ? { partialTpFillPrice: fillPrice } : {}),
    }).catch(() => {
      // best-effort — статус частичной фиксации не критичен для риск-движка
    });
    const moveResult = await moveStopLossAfterPartial(trade.id).catch((error) => {
      console.error("[realtime] не удалось подтянуть SL после partial:", error);
      return { moved: false, warning: "ошибка подтягивания SL" };
    });
    if (moveResult.warning && !moveResult.moved) {
      console.warn("[realtime] SL после partial не подтянут:", moveResult.warning);
    }
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
 *
 * Если первый запрос к BingX не нашёл исполненный ордер (API временно недоступен или
 * история ещё не синхронизирована), делается ещё одна попытка через 15 секунд —
 * прямо здесь, до записи результата. Это единственное место, где сделка получает
 * closeReason; отдельная пост-фактум реклассификация больше не нужна.
 */
export async function reconcilePositionFlat(symbol: string): Promise<void> {
  const trade = await getActiveTrade();
  if (!trade || trade.symbol !== symbol) return;

  const credentials = await getBingxCredentials();
  if (!credentials) return;

  const orderIds = (trade.bingxOrderIds as Record<string, string | number> | null) ?? {};

  let filled = await findFilledSlOrTp(credentials, trade, orderIds);

  if (!filled && (orderIds.sl !== undefined || orderIds.tp !== undefined)) {
    // BingX иногда не успевает обновить историю ордеров к моменту, когда ACCOUNT_UPDATE
    // уже прилетел. Ждём 15 секунд и пробуем ещё раз — до того как ставить "external".
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    filled = await findFilledSlOrTp(credentials, trade, orderIds).catch(() => null);
  }

  let closePrice: number;
  let realizedProfit: number | null = null;
  let closeReason: string;

  if (filled) {
    const resolved = resolveCloseFromFilledOrder(trade, filled);
    closeReason = resolved.closeReason;
    closePrice = resolved.closePrice;
    realizedProfit = resolved.realizedProfit;
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

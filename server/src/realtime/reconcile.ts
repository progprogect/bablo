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
import { computeResult } from "../trades/result.js";
import { finalizeTradeClose } from "../trades/service.js";
import type { OrderTradeUpdate } from "./accountStream.js";

export { computeResult } from "../trades/result.js";

const MAX_HISTORY_RANGE_MS = 7 * 24 * 60 * 60 * 1000 - 60_000; // BingX: не больше 7 дней

/**
 * Ищет, какой из сохранённых SL/TP-ордеров сделки реально исполнился (FILLED).
 * Экспортируется также для trades/reclassify.ts — та же логика нужна для повторной
 * сверки уже закрытых "external"-сделок.
 *
 * КЛЮЧЕВОЙ факт про BingX (найден эмпирически 16.07.2026 при разборе диагностики
 * реклассификации — см. docs/ROADMAP.md): когда условный STOP_MARKET/TAKE_PROFIT_MARKET
 * ордер срабатывает, сам ордер навсегда остаётся в статусе CANCELLED (никогда не
 * становится FILLED) — BingX создаёт вместо него НОВЫЙ market-ордер с ДРУГИМ orderId,
 * у которого поле triggerOrderId указывает на orderId исходного условного ордера.
 * Поэтому совпадение нужно искать не по orderId, а по triggerOrderId среди FILLED-
 * ордеров истории символа. Прежняя версия (поиск по orderId) никогда не находила
 * совпадений и все SL/TP-закрытия ошибочно классифицировались как "external".
 */
export async function findFilledSlOrTp(
  credentials: BingXCredentials,
  trade: Trade,
  orderIds: Record<string, string | number>,
): Promise<{ key: "sl" | "tp"; order: BingXOrderStatus } | null> {
  const { result } = await findFilledSlOrTpDebug(credentials, trade, orderIds);
  return result;
}

export type FindFilledDebugInfo = {
  historyOrdersCount: number;
  historyError: string | null;
  /** Что нашли в истории по каждому сохранённому orderId (undefined — не встретился в списке). */
  slInHistory: BingXOrderStatus | undefined;
  tpInHistory: BingXOrderStatus | undefined;
  /** Результат точечного лукапа (запасной путь), если до него дошло. */
  slStatusLookup: { order: BingXOrderStatus | null; error: string | null } | null;
  tpStatusLookup: { order: BingXOrderStatus | null; error: string | null } | null;
  /** Все ордера из истории за диапазон — чтобы найти те, что не входят в bingxOrderIds сделки. */
  historyOrders: BingXOrderStatus[];
};

/**
 * То же самое, что findFilledSlOrTp, но возвращает диагностику каждого шага — для
 * админ-эндпоинта /admin/reclassify-trades, чтобы видеть РЕАЛЬНУЮ причину, почему сделка
 * не реклассифицировалась (список пуст, ордер не найден в списке, ошибка API и т.п.),
 * а не гадать по документации.
 */
export async function findFilledSlOrTpDebug(
  credentials: BingXCredentials,
  trade: Trade,
  orderIds: Record<string, string | number>,
): Promise<{ result: { key: "sl" | "tp"; order: BingXOrderStatus } | null; debug: FindFilledDebugInfo }> {
  const debug: FindFilledDebugInfo = {
    historyOrdersCount: 0,
    historyError: null,
    slInHistory: undefined,
    tpInHistory: undefined,
    slStatusLookup: null,
    tpStatusLookup: null,
    historyOrders: [],
  };

  if (orderIds.sl === undefined && orderIds.tp === undefined) {
    return { result: null, debug };
  }

  const now = Date.now();
  const openedAtMs = trade.openedAt ? new Date(trade.openedAt).getTime() : now;
  const startTime = Math.max(openedAtMs, now - MAX_HISTORY_RANGE_MS);

  let history: BingXOrderStatus[] = [];
  try {
    history = await getOrderHistory(credentials, trade.symbol, startTime, now);
  } catch (error) {
    debug.historyError = error instanceof Error ? error.message : String(error);
  }
  debug.historyOrdersCount = history.length;
  debug.historyOrders = history;

  // Диагностический прямой лукап по orderId — почти всегда найдёт исходный условный
  // ордер со статусом CANCELLED (он не пропадает из истории), это ожидаемо и не значит,
  // что SL/TP не сработал — реальное исполнение ищем ниже, по triggerOrderId.
  const findInHistory = (id: string | number | undefined) =>
    id === undefined ? undefined : history.find((o) => String(o.orderId) === String(id));

  debug.slInHistory = findInHistory(orderIds.sl);
  debug.tpInHistory = findInHistory(orderIds.tp);

  // Реальное совпадение: FILLED-ордер, чей triggerOrderId равен нашему сохранённому
  // orderId условного SL/TP (либо, на всякий случай, прямое совпадение orderId).
  const findFilledFor = (id: string | number | undefined) =>
    id === undefined
      ? undefined
      : history.find(
          (o) => o.status === "FILLED" && (String(o.triggerOrderId) === String(id) || String(o.orderId) === String(id)),
        );

  const slFilled = findFilledFor(orderIds.sl);
  if (slFilled) return { result: { key: "sl", order: slFilled }, debug };
  const tpFilled = findFilledFor(orderIds.tp);
  if (tpFilled) return { result: { key: "tp", order: tpFilled }, debug };

  if (orderIds.sl !== undefined) {
    try {
      const order = await getOrderStatus(credentials, trade.symbol, orderIds.sl);
      debug.slStatusLookup = { order, error: null };
    } catch (error) {
      debug.slStatusLookup = { order: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (orderIds.tp !== undefined) {
    try {
      const order = await getOrderStatus(credentials, trade.symbol, orderIds.tp);
      debug.tpStatusLookup = { order, error: null };
    } catch (error) {
      debug.tpStatusLookup = { order: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (debug.slStatusLookup?.order?.status === "FILLED") {
    return { result: { key: "sl", order: debug.slStatusLookup.order }, debug };
  }
  if (debug.tpStatusLookup?.order?.status === "FILLED") {
    return { result: { key: "tp", order: debug.tpStatusLookup.order }, debug };
  }

  return { result: null, debug };
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

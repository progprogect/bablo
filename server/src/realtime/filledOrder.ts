import {
  getOrderHistory,
  getOrderStatus,
  type BingXCredentials,
  type BingXOrderStatus,
} from "../bingx/client.js";
import type { Trade } from "../db/repositories/trades.js";

const MAX_HISTORY_RANGE_MS = 7 * 24 * 60 * 60 * 1000 - 60_000; // BingX: не больше 7 дней

/**
 * Поиск реально исполнившегося SL/TP-ордера сделки и разбор его в результат закрытия.
 *
 * Вынесено из realtime/reconcile.ts отдельным модулем без зависимостей от trades/service:
 * этой же логикой пользуются и ручное закрытие (кнопка «Закрыть», когда позиции на бирже
 * уже нет), и сверка при старте сервера, и админская реклассификация. Модуль намеренно
 * не импортирует ничего из trades/ — иначе получается цикл service → reconcile → service.
 */

/**
 * Ищет, какой из сохранённых SL/TP-ордеров сделки реально исполнился (FILLED).
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

export type TradeForCloseResolve = {
  slPrice: string | number | null;
  tpPrice: string | number | null;
  entryPrice: string | number | null;
};

export type ResolvedClose = {
  closeReason: "sl" | "tp";
  closePrice: number;
  realizedProfit: number | null;
};

/**
 * Разбирает найденный FILLED-ордер в причину закрытия и цену. Чистая функция.
 *
 * Цена: avgPrice ордера, иначе сохранённая цена сработавшей стороны (SL/TP), иначе вход.
 * avgPrice=0 / пустой не подставляем как entry напрямую — иначе в истории окажется 0R
 * при реальном стопе (см. docs/ROADMAP.md, баг rp=0 от BingX).
 */
export function resolveCloseFromFilledOrder(
  trade: TradeForCloseResolve,
  filled: { key: "sl" | "tp"; order: Pick<BingXOrderStatus, "avgPrice" | "profit"> },
): ResolvedClose {
  const rawAvg = filled.order.avgPrice != null ? Number(filled.order.avgPrice) : NaN;
  let closePrice: number;
  if (Number.isFinite(rawAvg) && rawAvg > 0) {
    closePrice = rawAvg;
  } else {
    const fallback = Number(filled.key === "sl" ? trade.slPrice : trade.tpPrice);
    closePrice = Number.isFinite(fallback) && fallback > 0 ? fallback : Number(trade.entryPrice);
  }
  return {
    closeReason: filled.key,
    closePrice,
    realizedProfit: filled.order.profit !== undefined ? Number(filled.order.profit) : null,
  };
}

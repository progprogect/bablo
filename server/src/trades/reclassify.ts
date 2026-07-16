import type { BingXCredentials } from "../bingx/client.js";
import { listExternallyClosedTrades, updateTrade } from "../db/repositories/trades.js";
import { computeResult, findFilledSlOrTpDebug } from "../realtime/reconcile.js";

export type ReclassifyTradeDetail = {
  tradeId: number;
  symbol: string;
  openedAt: string;
  fixed: boolean;
  fixedAs?: "sl" | "tp";
  /** Сохранённые orderId сделки — чтобы можно было вручную сверить с BingX при необходимости. */
  orderIds: Record<string, string | number>;
  historyOrdersCount: number;
  historyError: string | null;
  slFoundInHistory: { orderId: string | number; status: string } | null;
  tpFoundInHistory: { orderId: string | number; status: string } | null;
  slStatusLookup: { status: string | null; error: string | null } | null;
  tpStatusLookup: { status: string | null; error: string | null } | null;
  /** Полный дамп истории ордеров символа (все поля, как их вернул BingX) — для ручного анализа. */
  historyOrders: unknown[];
};

export type ReclassifyResult = {
  checked: number;
  fixed: number;
  details: ReclassifyTradeDetail[];
};

/**
 * Повторная сверка сделок, закрытых как "external" — до фикса багов в getOrderStatus/
 * getOrderHistory (16.07.2026, см. docs/ROADMAP.md) реконсиляция никогда не могла
 * определить FILLED-статус SL/TP-ордера и всегда падала в эту ветку, даже когда сделка
 * реально закрылась по стопу или тейку. Возвращает подробную диагностику по каждой
 * проверенной сделке (findFilledSlOrTpDebug) — чтобы при необходимости видеть РЕАЛЬНЫЙ
 * ответ BingX, а не гадать по документации, если сделка всё равно не реклассифицировалась.
 */
export async function reclassifyExternalTrades(credentials: BingXCredentials): Promise<ReclassifyResult> {
  const tradesToCheck = await listExternallyClosedTrades();
  let fixed = 0;
  const details: ReclassifyTradeDetail[] = [];

  for (const trade of tradesToCheck) {
    const orderIds = (trade.bingxOrderIds as Record<string, string | number> | null) ?? {};
    const { result, debug } = await findFilledSlOrTpDebug(credentials, trade, orderIds);

    if (result) {
      const closePrice = Number(result.order.avgPrice) || Number(trade.entryPrice);
      const realizedProfit = result.order.profit !== undefined ? Number(result.order.profit) : null;
      const { resultR, resultPct } = computeResult(trade, closePrice, realizedProfit);
      await updateTrade(trade.id, { closeReason: result.key, closePrice, resultR, resultPct });
      fixed += 1;
    }

    details.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      openedAt: trade.openedAt.toISOString(),
      fixed: result !== null,
      fixedAs: result?.key,
      orderIds,
      historyOrdersCount: debug.historyOrdersCount,
      historyError: debug.historyError,
      slFoundInHistory: debug.slInHistory
        ? { orderId: debug.slInHistory.orderId, status: debug.slInHistory.status }
        : null,
      tpFoundInHistory: debug.tpInHistory
        ? { orderId: debug.tpInHistory.orderId, status: debug.tpInHistory.status }
        : null,
      slStatusLookup: debug.slStatusLookup
        ? { status: debug.slStatusLookup.order?.status ?? null, error: debug.slStatusLookup.error }
        : null,
      tpStatusLookup: debug.tpStatusLookup
        ? { status: debug.tpStatusLookup.order?.status ?? null, error: debug.tpStatusLookup.error }
        : null,
      historyOrders: debug.historyOrders,
    });
  }

  return { checked: tradesToCheck.length, fixed, details };
}

import { getOrderStatus, type BingXCredentials } from "../bingx/client.js";
import { listExternallyClosedTrades, updateTrade } from "../db/repositories/trades.js";
import { computeResult } from "../realtime/reconcile.js";

export type ReclassifyResult = {
  checked: number;
  fixed: number;
};

/**
 * Повторная сверка сделок, закрытых как "external" — до фикса бага в getOrderStatus
 * (16.07.2026, см. docs/ROADMAP.md) reconcilePositionFlat никогда не мог определить
 * FILLED-статус SL/TP-ордера и всегда падал в эту ветку, даже когда сделка реально
 * закрылась по стопу или тейку. Для каждой такой сделки повторно запрашиваем статус
 * сохранённых orderId — если BingX ещё отдаёт данные по ордеру (обычно доступно
 * недолго после закрытия), проставляем настоящую причину закрытия и пересчитываем
 * результат. Сделки, для которых BingX уже не находит ордер, остаются как есть.
 */
export async function reclassifyExternalTrades(credentials: BingXCredentials): Promise<ReclassifyResult> {
  const tradesToCheck = await listExternallyClosedTrades();
  let fixed = 0;

  for (const trade of tradesToCheck) {
    const orderIds = (trade.bingxOrderIds as Record<string, string | number> | null) ?? {};
    const [slStatus, tpStatus] = await Promise.all([
      orderIds.sl !== undefined ? getOrderStatus(credentials, trade.symbol, orderIds.sl).catch(() => null) : null,
      orderIds.tp !== undefined ? getOrderStatus(credentials, trade.symbol, orderIds.tp).catch(() => null) : null,
    ]);

    const filled =
      slStatus?.status === "FILLED"
        ? { key: "sl" as const, status: slStatus }
        : tpStatus?.status === "FILLED"
          ? { key: "tp" as const, status: tpStatus }
          : null;
    if (!filled) continue;

    const closePrice = Number(filled.status.avgPrice) || Number(trade.entryPrice);
    const realizedProfit = filled.status.profit !== undefined ? Number(filled.status.profit) : null;
    const { resultR, resultPct } = computeResult(trade, closePrice, realizedProfit);

    await updateTrade(trade.id, {
      closeReason: filled.key,
      closePrice,
      resultR,
      resultPct,
    });
    fixed += 1;
  }

  return { checked: tradesToCheck.length, fixed };
}

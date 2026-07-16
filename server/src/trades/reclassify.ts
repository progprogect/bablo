import type { BingXCredentials } from "../bingx/client.js";
import { listExternallyClosedTrades, updateTrade } from "../db/repositories/trades.js";
import { computeResult, findFilledSlOrTp } from "../realtime/reconcile.js";

export type ReclassifyResult = {
  checked: number;
  fixed: number;
};

/**
 * Повторная сверка сделок, закрытых как "external" — до фикса бага в getOrderStatus
 * (16.07.2026, см. docs/ROADMAP.md) reconcilePositionFlat никогда не мог определить
 * FILLED-статус SL/TP-ордера и всегда падал в эту ветку, даже когда сделка реально
 * закрылась по стопу или тейку. Использует ту же логику поиска, что и реалтайм-сверка
 * (findFilledSlOrTp — история ордеров символа, надёжнее точечного лукапа для условных
 * ордеров). Сделки, для которых BingX уже не находит данных по ордеру (истёк срок
 * хранения истории), остаются как есть.
 */
export async function reclassifyExternalTrades(credentials: BingXCredentials): Promise<ReclassifyResult> {
  const tradesToCheck = await listExternallyClosedTrades();
  let fixed = 0;

  for (const trade of tradesToCheck) {
    const orderIds = (trade.bingxOrderIds as Record<string, string | number> | null) ?? {};
    const filled = await findFilledSlOrTp(credentials, trade, orderIds);
    if (!filled) continue;

    const closePrice = Number(filled.order.avgPrice) || Number(trade.entryPrice);
    const realizedProfit = filled.order.profit !== undefined ? Number(filled.order.profit) : null;
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

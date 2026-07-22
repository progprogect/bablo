import { computeResultFromPrices, type TradeSide } from "./math.js";

/** Минимальные поля сделки, нужные для расчёта результата (не тянем весь ORM-тип). */
export type TradeForResult = {
  entryPrice: string | number | null;
  quantity: string | number;
  riskUsd: string | number | null;
  side: string;
  partialTpFilledAt?: Date | string | null;
  partialTpQuantity?: string | number | null;
  partialTpFillPrice?: string | number | null;
  partialTpPrice?: string | number | null;
};

/**
 * Результат сделки в R и %. Учитывает уже исполненную частичную фиксацию:
 * финальный ордер закрывает только остаток, его `realizedProfit` — без PnL partial.
 */
export function computeResult(
  trade: TradeForResult,
  closePrice: number,
  realizedProfit: number | null,
): { resultR: number; resultPct: number } {
  const entryPrice = Number(trade.entryPrice);
  const quantity = Number(trade.quantity);
  const riskUsd = Number(trade.riskUsd) || 0;
  const side = trade.side as TradeSide;
  const notional = entryPrice * quantity;

  /**
   * Если частичная фиксация уже исполнилась, финальный ордер (TP/SL) закрывает только
   * остаток (~30%). `realizedProfit` / `order.profit` с биржи — PnL ИМЕННО этого ордера,
   * без уже зафиксированных 70%. Без сложения частичного PnL сделка 1/5 с partial 1/3
   * могла записаться как ~1.5R вместо ~3.6R — и дневной лимит +3R не срабатывал.
   */
  const partialFilled = trade.partialTpFilledAt != null;
  const partialQtyRaw = Number(trade.partialTpQuantity);
  const partialPriceRaw =
    Number(trade.partialTpFillPrice) || Number(trade.partialTpPrice) || NaN;
  const partialQty =
    Number.isFinite(partialQtyRaw) && partialQtyRaw > 0 && partialQtyRaw < quantity
      ? partialQtyRaw
      : null;
  const partialPrice = Number.isFinite(partialPriceRaw) && partialPriceRaw > 0 ? partialPriceRaw : null;

  if (partialFilled && partialQty !== null && partialPrice !== null) {
    const priceDelta = (close: number) =>
      side === "long" ? close - entryPrice : entryPrice - close;
    const partialPnl = priceDelta(partialPrice) * partialQty;
    const remainderQty = quantity - partialQty;
    const remainderPnl =
      realizedProfit !== null && Number.isFinite(realizedProfit)
        ? realizedProfit
        : priceDelta(closePrice) * remainderQty;
    const totalPnl = partialPnl + remainderPnl;
    const resultR = riskUsd > 0 ? totalPnl / riskUsd : 0;
    const resultPct = notional > 0 ? (totalPnl / notional) * 100 : 0;
    return { resultR, resultPct };
  }

  if (realizedProfit !== null && Number.isFinite(realizedProfit)) {
    const resultR = riskUsd > 0 ? realizedProfit / riskUsd : 0;
    const resultPct = notional > 0 ? (realizedProfit / notional) * 100 : 0;
    return { resultR, resultPct };
  }

  return computeResultFromPrices(side, entryPrice, closePrice, quantity, riskUsd);
}

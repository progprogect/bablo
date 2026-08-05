import {
  computeResultFromPrices,
  isStopOnProfitSide,
  type TradeSide,
} from "./math.js";

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

/** Вход для выбора цены закрытия при ручном пересчёте resultR. */
export type ResolveRecalculateClosePriceInput = {
  side: TradeSide;
  entryPrice: number;
  quantity: number;
  riskUsd: number;
  slPrice: number | null;
  closePrice: number | null;
  closeReason: string | null;
  partialTpFilledAt?: Date | string | null;
  /** Фактический fill с BingX (если удалось найти). */
  bingxFillPrice?: number | null;
};

export type ResolveRecalculateClosePriceResult = {
  closePrice: number;
  source: "bingx" | "stored" | "sl";
};

/**
 * BingX на STOP_MARKET иногда присылает rp=0 при реальном убытке (проскальзывание).
 * Нулевой realizedProfit не доверяем, если цена закрытия даёт заметный |R|.
 */
const REALIZED_PROFIT_ZERO_EPS = 1e-8;
export const PRICE_BASED_R_TRUST_THRESHOLD = 0.05;

function preferPriceBasedOverZeroRp(
  realizedProfit: number,
  fromPrices: { resultR: number; resultPct: number },
): boolean {
  return (
    Math.abs(realizedProfit) < REALIZED_PROFIT_ZERO_EPS &&
    Math.abs(fromPrices.resultR) > PRICE_BASED_R_TRUST_THRESHOLD
  );
}

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
  const fromPrices = computeResultFromPrices(side, entryPrice, closePrice, quantity, riskUsd);

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
    let remainderPnl: number;
    if (realizedProfit !== null && Number.isFinite(realizedProfit)) {
      const remainderFromPrices = priceDelta(closePrice) * remainderQty;
      // rp=0 на остатке при реальном проскальзывании — берём цену закрытия.
      remainderPnl =
        Math.abs(realizedProfit) < REALIZED_PROFIT_ZERO_EPS &&
        Math.abs(remainderFromPrices) > REALIZED_PROFIT_ZERO_EPS
          ? remainderFromPrices
          : realizedProfit;
    } else {
      remainderPnl = priceDelta(closePrice) * remainderQty;
    }
    const totalPnl = partialPnl + remainderPnl;
    const resultR = riskUsd > 0 ? totalPnl / riskUsd : 0;
    const resultPct = notional > 0 ? (totalPnl / notional) * 100 : 0;
    return { resultR, resultPct };
  }

  if (realizedProfit !== null && Number.isFinite(realizedProfit)) {
    if (preferPriceBasedOverZeroRp(realizedProfit, fromPrices)) {
      return fromPrices;
    }
    const resultR = riskUsd > 0 ? realizedProfit / riskUsd : 0;
    const resultPct = notional > 0 ? (realizedProfit / notional) * 100 : 0;
    return { resultR, resultPct };
  }

  return fromPrices;
}

/**
 * Выбирает цену закрытия для пересчёта resultR.
 *
 * Кандидаты (по приоритету): fill BingX → сохранённый closePrice → slPrice
 * (для SL без partial, пока стоп защитный). Берём первого, у кого |R| ≥ порога.
 * Так fill/close ≈ entry (баг BingX rp=0) не блокирует откат на SL.
 */
export function resolveRecalculateClosePrice(
  input: ResolveRecalculateClosePriceInput,
): ResolveRecalculateClosePriceResult | null {
  const absRAt = (price: number) =>
    Math.abs(
      computeResultFromPrices(
        input.side,
        input.entryPrice,
        price,
        input.quantity,
        input.riskUsd,
      ).resultR,
    );

  const bingx =
    input.bingxFillPrice != null && Number.isFinite(input.bingxFillPrice) && input.bingxFillPrice > 0
      ? input.bingxFillPrice
      : null;
  const stored =
    input.closePrice != null && Number.isFinite(input.closePrice) && input.closePrice > 0
      ? input.closePrice
      : null;
  const sl =
    input.slPrice != null && Number.isFinite(input.slPrice) && input.slPrice > 0
      ? input.slPrice
      : null;

  const canUseSlFallback =
    input.closeReason === "sl" &&
    input.partialTpFilledAt == null &&
    sl != null &&
    Number.isFinite(input.entryPrice) &&
    input.entryPrice > 0 &&
    !isStopOnProfitSide(input.entryPrice, sl, input.side);

  const candidates: ResolveRecalculateClosePriceResult[] = [];
  if (bingx != null) candidates.push({ closePrice: bingx, source: "bingx" });
  if (stored != null) candidates.push({ closePrice: stored, source: "stored" });
  if (canUseSlFallback) candidates.push({ closePrice: sl, source: "sl" });

  if (candidates.length === 0) return null;

  const meaningful = candidates.find(
    (c) => absRAt(c.closePrice) >= PRICE_BASED_R_TRUST_THRESHOLD,
  );
  if (meaningful) return meaningful;

  // Все ≈0R: при защитном SL всё равно берём его (рискUsd=0 и т.п.), иначе первый кандидат.
  if (canUseSlFallback) return { closePrice: sl, source: "sl" };
  return candidates[0] ?? null;
}

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

/** Закрывающее исполнение из истории ордеров BingX (без ордера входа). */
export type ExchangeClosingFill = {
  /** Реализованный PnL этого исполнения (поле profit у BingX). */
  profit: number;
  /** Исполненный объём в монетах. */
  executedQty: number;
};

/**
 * Итог сделки по РЕАЛЬНЫМ исполнениям с биржи — источник правды, когда пользователь
 * менял ордера прямо на BingX (например, передвинул частичную фиксацию): биржа отменяет
 * ордер приложения и создаёт новый с другим id, приложение этот fill не видит, и расчёт
 * по сохранённым планам расходится с фактом.
 *
 * Суммируем profit всех FILLED-закрытий из истории. Если история ещё не содержит
 * финальное исполнение (BingX обновляет её с задержкой — известный лаг, см. retry в
 * reconcilePositionFlat), добиваем остаток объёма PnL финального ордера: rp из WS-события,
 * а при rp≈0 на реальном ходе цены (баг BingX) — расчётом от цены закрытия.
 *
 * null — посчитать нельзя (нет объёма/входа); суммы не искажаем, вызывающая сторона
 * остаётся на своём фолбэке.
 */
export function computeResultFromExchangeFills(
  trade: Pick<TradeForResult, "entryPrice" | "quantity" | "riskUsd" | "side">,
  closingFills: ExchangeClosingFill[],
  finalFill: { closePrice: number; realizedProfit: number | null },
): { resultR: number; resultPct: number } | null {
  const entryPrice = Number(trade.entryPrice);
  const quantity = Number(trade.quantity);
  const riskUsd = Number(trade.riskUsd) || 0;
  const side = trade.side as TradeSide;
  if (!(entryPrice > 0) || !(quantity > 0)) return null;

  let historyPnl = 0;
  let historyQty = 0;
  for (const fill of closingFills) {
    if (Number.isFinite(fill.profit)) historyPnl += fill.profit;
    if (Number.isFinite(fill.executedQty) && fill.executedQty > 0) historyQty += fill.executedQty;
  }

  const priceDelta = (close: number) => (side === "long" ? close - entryPrice : entryPrice - close);
  const remainderQty = Math.max(0, quantity - Math.min(historyQty, quantity));
  let totalPnl = historyPnl;
  // Порог 0.1% объёма — от float-шума количеств, а не «допуск на недозакрытие».
  if (remainderQty > quantity * 0.001) {
    const remainderFromPrice = priceDelta(finalFill.closePrice) * remainderQty;
    const rp = finalFill.realizedProfit;
    const useRp =
      rp !== null &&
      Number.isFinite(rp) &&
      !(Math.abs(rp) < REALIZED_PROFIT_ZERO_EPS && Math.abs(remainderFromPrice) > REALIZED_PROFIT_ZERO_EPS);
    totalPnl += useRp ? rp : remainderFromPrice;
  }

  const notional = entryPrice * quantity;
  return {
    resultR: riskUsd > 0 ? totalPnl / riskUsd : 0,
    resultPct: notional > 0 ? (totalPnl / notional) * 100 : 0,
  };
}

/**
 * Доверять ли итогу с биржи вместо расчётного. Единственный случай недоверия — почерк
 * бага rp=0: биржа насчитала «около нуля», а наш расчёт по ценам даёт материальный |R|.
 * Во всех остальных случаях биржа главнее: она видит исполнения, о которых приложение
 * могло не узнать (ордера, изменённые вручную на BingX).
 */
export function shouldTrustExchangeResult(exchangeR: number, fallbackR: number): boolean {
  return !(Math.abs(exchangeR) < PRICE_BASED_R_TRUST_THRESHOLD && Math.abs(fallbackR) > 0.25);
}

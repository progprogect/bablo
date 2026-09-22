import type { Trade } from "../db/repositories/trades.js";
import { resolveStatsResultR, resolveTradeOutcome, type TradeOutcome } from "../history/outcome.js";
import { entryRiskDistance, initialSlPrice, mfeR, plannedRR, type TradeGeometry } from "./logic.js";

/**
 * Маппинг сделки в JSON журнала. Исход и фактический R — те же resolveTradeOutcome /
 * resolveStatsResultR, что в Истории и статистике: карточка в журнале не может
 * разойтись с карточкой в терминале.
 */

export type JournalTradeCard = {
  id: number;
  symbol: string;
  side: "long" | "short";
  openedAt: string;
  closedAt: string | null;
  entryPrice: number | null;
  /** Стоп ПРИ ВХОДЕ (восстановлен из riskUsd/qty — текущий slPrice могли подтянуть). */
  initialSlPrice: number | null;
  /** Тейк по плану входа (tp_price_initial; для старых сделок — текущий tpPrice). */
  plannedTpPrice: number | null;
  /** R/R по плану входа. */
  plannedRR: number | null;
  outcome: TradeOutcome;
  /** Фактический R — тот же, что во всей статистике. */
  statsResultR: number | null;
  /** Реализованный результат в USDT: resultR × риск сделки. */
  resultUsd: number | null;
  categoryId: number | null;
};

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function geometry(trade: Trade): TradeGeometry {
  return {
    side: trade.side as "long" | "short",
    entryPrice: toNumber(trade.entryPrice),
    slPrice: toNumber(trade.slPrice),
    quantity: toNumber(trade.quantity),
    riskUsd: toNumber(trade.riskUsd),
  };
}

export function toTradeCard(trade: Trade, categoryId: number | null): JournalTradeCard {
  const geo = geometry(trade);
  const resultR = toNumber(trade.resultR);
  const outcome = resolveTradeOutcome(
    {
      closeReason: trade.closeReason,
      entryPrice: geo.entryPrice,
      slPrice: geo.slPrice,
      side: trade.side,
      statsOutcome: trade.statsOutcome,
    },
    resultR ?? 0,
  );
  const statsResultR = resolveStatsResultR({ statsRrPreset: trade.statsRrPreset, resultR }, outcome);
  const riskUsd = geo.riskUsd;
  const plannedTp = toNumber(trade.tpPriceInitial) ?? toNumber(trade.tpPrice);
  return {
    id: trade.id,
    symbol: trade.symbol,
    side: geo.side,
    openedAt: trade.openedAt.toISOString(),
    closedAt: trade.closedAt ? trade.closedAt.toISOString() : null,
    entryPrice: geo.entryPrice,
    initialSlPrice: initialSlPrice(geo),
    plannedTpPrice: plannedTp,
    plannedRR: plannedRR(geo, plannedTp),
    outcome,
    statsResultR,
    resultUsd: resultR !== null && riskUsd !== null ? resultR * riskUsd : null,
    categoryId,
  };
}

export type JournalTradeDetail = JournalTradeCard & {
  quantity: number | null;
  leverage: number;
  riskUsd: number | null;
  closePrice: number | null;
  closeReason: string | null;
  resultR: number | null;
  resultPct: number | null;
  /** Текущий (финальный) стоп — отличается от initialSlPrice, если стоп подтягивали. */
  finalSlPrice: number | null;
  /** Потенциальная прибыль по плану входа: plannedRR × риск. */
  plannedProfitUsd: number | null;
  /** Изолированная маржа: объём × вход / плечо. */
  marginUsd: number | null;
  mfePrice: number | null;
  /** MFE в R от исходного риска — докуда цена реально доходила в сторону тейка. */
  mfeR: number | null;
  beCrossed: boolean;
};

export function toTradeDetail(trade: Trade, categoryId: number | null): JournalTradeDetail {
  const card = toTradeCard(trade, categoryId);
  const geo = geometry(trade);
  const quantity = geo.quantity;
  const mfePrice = toNumber(trade.mfePrice);
  const marginUsd =
    geo.entryPrice !== null && quantity !== null && trade.leverage > 0
      ? (geo.entryPrice * quantity) / trade.leverage
      : null;
  return {
    ...card,
    quantity,
    leverage: trade.leverage,
    riskUsd: geo.riskUsd,
    closePrice: toNumber(trade.closePrice),
    closeReason: trade.closeReason,
    resultR: toNumber(trade.resultR),
    resultPct: toNumber(trade.resultPct),
    finalSlPrice: geo.slPrice,
    plannedProfitUsd:
      card.plannedRR !== null && geo.riskUsd !== null ? card.plannedRR * geo.riskUsd : null,
    marginUsd,
    mfePrice,
    mfeR: mfeR(geo, mfePrice),
    beCrossed: trade.beCrossed,
  };
}

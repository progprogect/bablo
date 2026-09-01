import type { BingXIncomeRecord } from "../bingx/client.js";

// ВНИМАНИЕ: функции «восстановить баланс на границу из журнала» здесь больше нет и быть
// не должно (жила один день, 30.08.2026): журнал user/income НЕ содержит переводов,
// поэтому «текущий баланс минус записи после границы» приписывает прошлому все
// пополнения, внесённые с тех пор. Границы депозита — только по дневным снимкам.

export type TradeForIncomeMatch = {
  id: number;
  symbol: string;
  openedAt: Date;
  closedAt: Date | null;
};

export type IncomeMatchResult = {
  /** Реализованный PnL биржи по каждой сделке (id → сумма записей REALIZED_PNL). */
  pnlByTradeId: Map<number, number>;
  /** PnL записей, не попавших ни в одну сделку — позиции, открытые мимо приложения. */
  unmatchedPnlUsd: number;
  unmatchedCount: number;
};

/** Запись закрытия может прийти чуть раньше, чем приложение зафиксировало сделку, или чуть позже. */
const MATCH_BEFORE_OPEN_MS = 60_000;
const MATCH_AFTER_CLOSE_MS = 5 * 60_000;

/**
 * Привязывает записи REALIZED_PNL к сделкам по символу и времени. Приложение держит
 * одновременно только ОДНУ активную сделку, поэтому интервалы сделок не пересекаются и
 * привязка однозначна. Одна сделка может дать несколько записей — частичная фиксация
 * закрывает позицию по частям, и каждое исполнение приходит отдельной записью
 * (именно поэтому число записей больше числа сделок — это норма, а не потеря данных).
 *
 * Нужно, чтобы найти КОНКРЕТНЫЕ сделки, где сумма приложения разошлась с биржей, —
 * их потом чинит «Пересчитать» в админке.
 */
export function matchIncomeToTrades(
  records: BingXIncomeRecord[],
  trades: TradeForIncomeMatch[],
): IncomeMatchResult {
  const pnlByTradeId = new Map<number, number>();
  let unmatchedPnlUsd = 0;
  let unmatchedCount = 0;

  const closed = trades.filter((trade) => trade.closedAt !== null);

  for (const record of records) {
    if (!record.incomeType.toUpperCase().includes("PNL")) continue;
    const amount = Number(record.income);
    if (!Number.isFinite(amount)) continue;

    const candidates = closed.filter(
      (trade) =>
        (!record.symbol || trade.symbol === record.symbol) &&
        record.time >= trade.openedAt.getTime() - MATCH_BEFORE_OPEN_MS &&
        record.time <= trade.closedAt!.getTime() + MATCH_AFTER_CLOSE_MS,
    );

    if (candidates.length === 0) {
      unmatchedPnlUsd += amount;
      unmatchedCount += 1;
      continue;
    }

    // На всякий случай (пересекающиеся интервалы из-за буферов) — ближайшая по закрытию.
    const best = candidates.reduce((closest, trade) =>
      Math.abs(record.time - trade.closedAt!.getTime()) <
      Math.abs(record.time - closest.closedAt!.getTime())
        ? trade
        : closest,
    );
    pnlByTradeId.set(best.id, (pnlByTradeId.get(best.id) ?? 0) + amount);
  }

  return { pnlByTradeId, unmatchedPnlUsd, unmatchedCount };
}

/**
 * Суммы начислений фьючерсного счёта за период — ФАКТ с биржи для сверки месячной
 * статистики (блок «Депозит» в детализации месяца): не наша оценка «что осталось
 * необъяснённым», а реальные записи BingX по типам.
 */
export type IncomeTypeTotal = { type: string; sumUsd: number; count: number };

export type IncomeSummary = {
  /** Комиссии биржи (отрицательные). */
  commissionUsd: number;
  /** Funding-платежи (со знаком: списания < 0, начисления > 0). */
  fundingUsd: number;
  /** Переводы на/со счёта (пополнения > 0, выводы < 0) — факт вместо ручных записей админки. */
  transfersUsd: number;
  /** Реализованный PnL по данным биржи — сверка с итогом сделок приложения. */
  realizedPnlUsd: number;
  /** Всё остальное (страховой фонд, ADL и т.п.) — обычно ноль. */
  otherUsd: number;
  recordCount: number;
  /**
   * СЫРАЯ разбивка по incomeType, как их назвала биржа — чтобы «не сходится на X»
   * можно было объяснить данными, а не догадками: видно и незнакомый тип начисления,
   * и сколько записей каждого вида пришло (число REALIZED_PNL против числа сделок
   * в приложении сразу показывает, все ли сделки учтены).
   */
  byType: IncomeTypeTotal[];
  /** Границы реально полученных записей — если они уже месяца, история биржи неполная. */
  firstRecordAt: string | null;
  lastRecordAt: string | null;
};

/**
 * Тип начисления мапится по вхождению подстроки, а не по точному совпадению: у BingX
 * встречаются вариации имён (TRADING_FEE/COMMISSION, TRANSFER/TRANSFER_IN…), и промах
 * маппинга молча утёк бы в «прочее». Сырые имена всё равно остаются в byType.
 */
function classify(incomeType: string): keyof Pick<
  IncomeSummary,
  "commissionUsd" | "fundingUsd" | "transfersUsd" | "realizedPnlUsd" | "otherUsd"
> {
  const type = incomeType.toUpperCase();
  if (type.includes("FUNDING")) return "fundingUsd";
  if (type.includes("FEE") || type.includes("COMMISSION")) return "commissionUsd";
  if (type.includes("TRANSFER") || type.includes("DEPOSIT") || type.includes("WITHDRAW")) {
    return "transfersUsd";
  }
  if (type.includes("PNL")) return "realizedPnlUsd";
  return "otherUsd";
}

export function summarizeIncome(records: BingXIncomeRecord[]): IncomeSummary {
  const summary: IncomeSummary = {
    commissionUsd: 0,
    fundingUsd: 0,
    transfersUsd: 0,
    realizedPnlUsd: 0,
    otherUsd: 0,
    recordCount: records.length,
    byType: [],
    firstRecordAt: null,
    lastRecordAt: null,
  };

  const byType = new Map<string, IncomeTypeTotal>();
  let minTime: number | null = null;
  let maxTime: number | null = null;

  for (const record of records) {
    const amount = Number(record.income);
    if (!Number.isFinite(amount)) continue;
    summary[classify(record.incomeType)] += amount;

    const entry = byType.get(record.incomeType) ?? { type: record.incomeType, sumUsd: 0, count: 0 };
    entry.sumUsd += amount;
    entry.count += 1;
    byType.set(record.incomeType, entry);

    if (Number.isFinite(record.time)) {
      if (minTime === null || record.time < minTime) minTime = record.time;
      if (maxTime === null || record.time > maxTime) maxTime = record.time;
    }
  }

  summary.byType = [...byType.values()].sort((a, b) => Math.abs(b.sumUsd) - Math.abs(a.sumUsd));
  summary.firstRecordAt = minTime === null ? null : new Date(minTime).toISOString();
  summary.lastRecordAt = maxTime === null ? null : new Date(maxTime).toISOString();
  return summary;
}

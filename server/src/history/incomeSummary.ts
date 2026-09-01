import type { BingXIncomeRecord } from "../bingx/client.js";

/**
 * Суммы начислений фьючерсного счёта за период — ФАКТ с биржи для сверки месячной
 * статистики (блок «Депозит» в детализации месяца): не наша оценка «что осталось
 * необъяснённым», а реальные записи BingX по типам.
 */
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
};

const COMMISSION_TYPES = new Set(["TRADING_FEE", "COMMISSION"]);

export function summarizeIncome(records: BingXIncomeRecord[]): IncomeSummary {
  const summary: IncomeSummary = {
    commissionUsd: 0,
    fundingUsd: 0,
    transfersUsd: 0,
    realizedPnlUsd: 0,
    otherUsd: 0,
    recordCount: records.length,
  };

  for (const record of records) {
    const amount = Number(record.income);
    if (!Number.isFinite(amount)) continue;
    if (COMMISSION_TYPES.has(record.incomeType)) {
      summary.commissionUsd += amount;
    } else if (record.incomeType === "FUNDING_FEE") {
      summary.fundingUsd += amount;
    } else if (record.incomeType === "TRANSFER") {
      summary.transfersUsd += amount;
    } else if (record.incomeType === "REALIZED_PNL") {
      summary.realizedPnlUsd += amount;
    } else {
      summary.otherUsd += amount;
    }
  }

  return summary;
}

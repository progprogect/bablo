import type { BingXIncomeRecord } from "../bingx/client.js";

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

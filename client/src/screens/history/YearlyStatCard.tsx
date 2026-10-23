import type { MonthlyStat } from "../../api/types";
import { StatCardBody, type StatCardData } from "./MonthlyStatCard";

/** Месяцы в родительном падеже — для сноски «% считается с августа». */
const MONTH_FROM_LABELS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

/**
 * Итоги года — сумма карточек его месяцев (просьба пользователя от 23.10.2026).
 *
 * Агрегат считается на КЛИЕНТЕ из тех же MonthlyStat, что нарисованы ниже: карточка года
 * обязана сходиться с суммой карточек месяцев на том же экране, а второй расчёт на
 * сервере — второй шанс разойтись.
 */

type YearlyStat = StatCardData & {
  year: number;
  /** Месяц (1–12), с начала которого считается % года; null — % недоступен вовсе. */
  pctFromMonth: number | null;
  /**
   * false — в году есть торговые месяцы РАНЬШЕ точки отсчёта % (у них не было снимков
   * депозита), то есть % охватывает не всю видимую историю года: об этом честно говорит
   * сноска. Если торговля и так началась с точки отсчёта, помечать нечего.
   */
  pctCoversAllMonths: boolean;
};

/** Числитель винрейта месяца. Фолбэк для ответа сервера без winCount (до 23.10.2026). */
function monthWinCount(stat: MonthlyStat): number {
  return stat.winCount ?? Math.round(stat.winRate * stat.totalTrades);
}

/** "1/1.5" → 1.5 — для сортировки пресетов в шапке таблицы, как в месяцах. */
function presetR(preset: string): number {
  const value = Number(preset.split("/")[1]);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

export function aggregateYear(year: number, monthsOfYear: MonthlyStat[]): YearlyStat {
  // По возрастанию месяца: агрегату нужен «первый месяц со снимком» и «последний с данными».
  const months = [...monthsOfYear].sort((a, b) => a.month - b.month);

  let totalTrades = 0;
  let winCount = 0;
  let tpCount = 0;
  let slCount = 0;
  let beCount = 0;
  let tradingDays = 0;
  let sumR = 0;
  let sumPositiveR = 0;
  let sumNegativeR = 0;
  const byPreset = new Map<string, number>();

  for (const stat of months) {
    totalTrades += stat.totalTrades;
    winCount += monthWinCount(stat);
    tpCount += stat.tpCount;
    slCount += stat.slCount;
    beCount += stat.beCount;
    tradingDays += stat.tradingDays;
    sumR += stat.sumR;
    sumPositiveR += stat.sumPositiveR;
    sumNegativeR += stat.sumNegativeR;
    for (const entry of stat.byRRPreset) {
      byPreset.set(entry.preset, (byPreset.get(entry.preset) ?? 0) + entry.count);
    }
  }

  /*
   * % года — той же формулой, что % месяца (server/src/history/monthlyStats.ts):
   * (депозит на конец − депозит на начало − пополнения/выводы) / депозит на начало.
   * Начало — первый месяц года, у которого есть снимок депозита: у месяцев до появления
   * снимков resultPct нет и у самих, из них год не посчитать. Пополнения/выводы берутся
   * только с этого месяца — adjustments более ранних не двигали учитываемый отрезок.
   */
  const baseMonth = months.find((stat) => stat.startEquity !== null && stat.startEquity > 0) ?? null;
  const lastWithEnd = [...months].reverse().find((stat) => stat.endEquity !== null) ?? null;
  let resultPct: number | null = null;
  if (baseMonth && lastWithEnd && lastWithEnd.month >= baseMonth.month) {
    const adjustmentsUsd = months
      .filter((stat) => stat.month >= baseMonth.month && stat.month <= lastWithEnd.month)
      .reduce((sum, stat) => sum + stat.adjustmentsUsd, 0);
    resultPct =
      ((lastWithEnd.endEquity! - baseMonth.startEquity! - adjustmentsUsd) / baseMonth.startEquity!) *
      100;
  }

  return {
    year,
    totalTrades,
    winRate: totalTrades > 0 ? winCount / totalTrades : 0,
    tpCount,
    slCount,
    beCount,
    tradingDays,
    sumR,
    sumPositiveR,
    sumNegativeR,
    byRRPreset: [...byPreset.entries()]
      .map(([preset, count]) => ({ preset, count }))
      .sort((a, b) => presetR(a.preset) - presetR(b.preset)),
    resultPct,
    pctFromMonth: resultPct !== null ? baseMonth!.month : null,
    pctCoversAllMonths:
      resultPct === null || months.length === 0 || baseMonth!.month === months[0]!.month,
  };
}

export function YearlyStatCard({ stat }: { stat: YearlyStat }) {
  // Сноска: % недоступен вовсе — или покрывает не всю видимую историю года.
  let footnote: string | null = null;
  if (stat.resultPct === null) {
    footnote = "% к депозиту недоступен — нет снимков баланса за этот год";
  } else if (!stat.pctCoversAllMonths && stat.pctFromMonth !== null) {
    footnote = `% считается с ${MONTH_FROM_LABELS[stat.pctFromMonth - 1]} — раньше снимков депозита не было`;
  }

  return <StatCardBody title={`Итоги ${stat.year}`} data={stat} footnote={footnote} />;
}

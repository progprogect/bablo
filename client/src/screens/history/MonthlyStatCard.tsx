import type { MonthlyStat } from "../../api/types";
import { trimTrailingZeros } from "../../lib/format";

const MONTH_LABELS = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

function formatSignedPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${trimTrailingZeros(value)}%`;
}

export function MonthlyStatCard({ stat }: { stat: MonthlyStat }) {
  const isProfit = stat.resultPct !== null ? stat.resultPct > 0 : stat.sumR > 0;
  const isLoss = stat.resultPct !== null ? stat.resultPct < 0 : stat.sumR < 0;
  const resultColorClass = isProfit ? "text-emerald-600" : isLoss ? "text-red-600" : "text-slate-600";

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-ink">
          {MONTH_LABELS[stat.month - 1]} {stat.year}
        </h3>
        <div className="flex items-baseline gap-2">
          <span className={`text-base font-semibold ${resultColorClass}`}>
            {stat.resultPct !== null ? formatSignedPercent(stat.resultPct) : "—"}
          </span>
          <span className="text-xs text-slate-500">
            {stat.sumR > 0 ? "+" : ""}
            {trimTrailingZeros(stat.sumR)}R
          </span>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-y-2 text-sm">
        <Row label="Всего сделок" value={String(stat.totalTrades)} />
        <Row label="Винрейт" value={`${trimTrailingZeros(stat.winRate * 100)}%`} />
        <Row label="TP / SL / Б/У" value={`${stat.tpCount} / ${stat.slCount} / ${stat.beCount}`} />
        <Row label="Торговых дней" value={`${stat.tradingDays} / ${stat.daysWithoutTrading} без торговли`} />
      </dl>

      {stat.byRRPreset.length > 0 && (
        <p className="text-xs text-slate-500">
          По тейку: {stat.byRRPreset.map((entry) => `${entry.preset} — ${entry.count}`).join(" · ")}
        </p>
      )}

      {stat.resultPct === null && (
        <p className="text-xs text-slate-400">
          % к депозиту недоступен — нет снимка баланса на начало месяца
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

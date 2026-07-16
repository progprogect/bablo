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

/** "1/1" → "1R", "1/1.5" → "1.5R" — R-множитель пресета (после слэша), для компактной шапки таблицы. */
function presetRLabel(preset: string): string {
  const parts = preset.split("/");
  return `${parts[1] ?? preset}R`;
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
        <Row label="Торговых дней" value={String(stat.tradingDays)} />
      </dl>

      {stat.byRRPreset.length > 0 && (
        <div className="flex items-start justify-between gap-3 border-t border-line pt-2.5">
          <div className="flex flex-1 flex-wrap gap-x-2.5 gap-y-1.5">
            {stat.byRRPreset.map((entry) => (
              <div key={entry.preset} className="flex min-w-[26px] flex-col items-center">
                <span className="text-[10px] text-slate-400">{presetRLabel(entry.preset)}</span>
                <span className="text-xs font-medium text-ink">{entry.count}</span>
              </div>
            ))}
          </div>
          <div className="flex shrink-0 flex-col items-center border-l border-line pl-2.5">
            <span className="text-[10px] text-slate-400">+R / −R</span>
            <span className="text-xs font-medium">
              <span className="text-emerald-600">+{trimTrailingZeros(stat.sumPositiveR)}</span>
              <span className="text-slate-400"> / </span>
              <span className="text-red-600">{trimTrailingZeros(stat.sumNegativeR)}</span>
            </span>
          </div>
        </div>
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

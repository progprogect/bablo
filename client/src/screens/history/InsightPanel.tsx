import type { TimeOfDayStats } from "../../api/types";

const PERIOD_LABELS: Record<TimeOfDayStats["periods"][number]["key"], string> = {
  night: "Ночь (00:00–06:00)",
  morning: "Утро (06:00–12:00)",
  day: "День (12:00–18:00)",
  evening: "Вечер (18:00–24:00)",
};

export function InsightPanel({ stats }: { stats: TimeOfDayStats }) {
  const totalTrades = stats.periods.reduce((sum, p) => sum + p.totalTrades, 0);
  if (totalTrades === 0) {
    return null;
  }

  const best = stats.bestPeriod ? stats.periods.find((p) => p.key === stats.bestPeriod) : null;

  return (
    <div className="mx-4 flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-slate-500">Время дня</p>

      {best ? (
        <p className="text-sm text-ink">
          Чаще всего прибыльные сделки — <span className="text-accent">{PERIOD_LABELS[best.key]}</span>:{" "}
          {best.profitableTrades} из {best.totalTrades}.
        </p>
      ) : (
        <p className="text-sm text-slate-500">Пока нет закрытых прибыльных сделок для инсайта.</p>
      )}

      <dl className="grid grid-cols-2 gap-y-1.5 text-xs text-slate-500">
        {stats.periods.map((period) => (
          <div key={period.key} className="flex justify-between gap-2">
            <dt>{PERIOD_LABELS[period.key]}</dt>
            <dd className="text-slate-600">
              {period.totalTrades > 0 ? `${period.profitableTrades}/${period.totalTrades}` : "—"}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

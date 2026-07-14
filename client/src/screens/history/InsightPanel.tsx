import type { TradeInsights } from "../../api/types";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** "15" → "15:00–16:00" (перенос через полночь показываем как "23:00–00:00"). */
function formatHourRange(hour: number): string {
  const next = (hour + 1) % 24;
  return `${pad2(hour)}:00–${pad2(next)}:00`;
}

const EMPTY_HOURS_LIMIT = 3;

export function InsightPanel({ insights }: { insights: TradeInsights }) {
  const hasAnyData =
    insights.topProfitableHours.length > 0 ||
    insights.topStopHours.length > 0 ||
    insights.bestAsset !== null ||
    insights.dailyTargetHour !== null ||
    insights.emptyHours.length < 24;

  if (!hasAnyData) return null;

  const shownEmptyHours = insights.emptyHours.slice(0, EMPTY_HOURS_LIMIT);
  const extraEmptyHours = insights.emptyHours.length - shownEmptyHours.length;

  return (
    <div className="mx-4 flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <h3 className="text-sm font-medium text-ink">Подсказка</h3>
      <ul className="flex flex-col gap-1.5 text-xs text-slate-600">
        {insights.topProfitableHours.length > 0 && (
          <li>
            Чаще всего прибыльные сделки открыты в:{" "}
            {insights.topProfitableHours
              .map((bucket) => `${formatHourRange(bucket.hour)} ${bucket.profitable}/${bucket.total}`)
              .join(", ")}
          </li>
        )}

        {insights.bestAsset && (
          <li>
            Самый прибыльный актив: {insights.bestAsset.symbol.replace(/-USDT$/, "")} (
            {insights.bestAsset.tpCount} {insights.bestAsset.tpCount === 1 ? "сделка" : "сделок"} по тейку)
          </li>
        )}

        {shownEmptyHours.length > 0 && (
          <li>
            Не было открытых сделок: {shownEmptyHours.map(formatHourRange).join(", ")}
            {extraEmptyHours > 0 ? ` и ещё ${extraEmptyHours}` : ""}
          </li>
        )}

        {insights.topStopHours.length > 0 && (
          <li>
            Чаще всего идут в стоп сделки, открытые в:{" "}
            {insights.topStopHours
              .map((bucket) => `${formatHourRange(bucket.hour)} (${bucket.count})`)
              .join(", ")}
          </li>
        )}

        {insights.dailyTargetHour && (
          <li>
            Обычно закрываю дневную цель +{insights.dailyTargetHour.targetR}R к{" "}
            {pad2(insights.dailyTargetHour.hour)}:00
          </li>
        )}
      </ul>
    </div>
  );
}

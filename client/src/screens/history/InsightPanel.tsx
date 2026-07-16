import { useState } from "react";
import type { PresetOutcome, TradeInsights } from "../../api/types";
import { trimTrailingZeros } from "../../lib/format";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** "9" → "9-10ч" (перенос через полночь — "23-0ч"). */
function formatHourRangeShort(hour: number): string {
  const next = (hour + 1) % 24;
  return `${hour}-${next}ч`;
}

/**
 * "По пресету R/R 1/2 — по тейку 1/2 (50%). Из них 1/1 закрылись по стопу, в среднем -1R."
 * hitRate отвечает на "как часто цена доходит до цели", а средний R закрытых по стопу — на
 * "сколько в среднем стоит промах" (без смешивания с прибыльными исходами, что и было
 * непонятным в прежней версии одного общего "среднего").
 */
function formatPresetOutcome(entry: PresetOutcome): string {
  const hitPct = Math.round(entry.hitRate * 100);
  const base = `R/R ${entry.preset} — по тейку ${entry.tpCount}/${entry.totalTrades} (${hitPct}%).`;
  const nonTpCount = entry.totalTrades - entry.tpCount;

  if (nonTpCount === 0) {
    return `${base} Все сделки с этим пресетом дошли до тейка.`;
  }
  if (entry.slCount === 0) {
    return base;
  }

  const avgSign = entry.avgSlResultR > 0 ? "+" : "";
  return `${base} Из них ${entry.slCount}/${nonTpCount} закрылись по стопу, в среднем ${avgSign}${trimTrailingZeros(entry.avgSlResultR)}R.`;
}

/** Список пресетов R/R с раскрытием по кнопке, если он не влезает в отведённый лимит. */
function PresetOutcomesList({ items, limit }: { items: PresetOutcome[]; limit: number }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, limit);
  const hiddenCount = items.length - shown.length;

  return (
    <div className="flex flex-col gap-1">
      {shown.map((entry) => (
        <p key={entry.preset}>{formatPresetOutcome(entry)}</p>
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="self-start font-medium text-accent underline-offset-2 hover:underline"
        >
          и ещё {hiddenCount}
        </button>
      )}
      {expanded && items.length > limit && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="self-start font-medium text-accent underline-offset-2 hover:underline"
        >
          свернуть
        </button>
      )}
    </div>
  );
}

const VISIBLE_PRESETS_LIMIT = 2;

export function InsightPanel({ insights }: { insights: TradeInsights }) {
  const hasAnyData =
    insights.topProfitableHours.length > 0 ||
    insights.topStopHours.length > 0 ||
    insights.bestAsset !== null ||
    insights.dailyTargetHour !== null ||
    insights.presetOutcomes.length > 0;

  if (!hasAnyData) return null;

  return (
    <div className="mx-4 flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <h3 className="text-sm font-medium text-ink">Подсказка</h3>
      <ul className="flex flex-col gap-1.5 text-xs text-slate-600">
        {insights.topProfitableHours.length > 0 && (
          <li>
            Самые прибыльные часы:{" "}
            {insights.topProfitableHours
              .map((bucket) => `${formatHourRangeShort(bucket.hour)} — ${bucket.tpCount}/${bucket.total} TP`)
              .join(", ")}
          </li>
        )}

        {insights.bestAsset && (
          <li>
            Самый прибыльный актив: {insights.bestAsset.symbol.replace(/-USDT$/, "")} —{" "}
            {insights.bestAsset.tpCount}/{insights.bestAsset.totalTrades} TP (
            {Math.round((insights.bestAsset.tpCount / insights.bestAsset.totalTrades) * 100)}%)
          </li>
        )}

        {insights.presetOutcomes.length > 0 && (
          <li>
            <PresetOutcomesList items={insights.presetOutcomes} limit={VISIBLE_PRESETS_LIMIT} />
          </li>
        )}

        {insights.topStopHours.length > 0 && (
          <li>
            Чаще всего идут в стоп сделки, открытые в:{" "}
            {insights.topStopHours
              .map((bucket) => `${formatHourRangeShort(bucket.hour)} (${bucket.count})`)
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

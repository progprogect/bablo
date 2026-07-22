import { useState } from "react";
import type { PresetOutcome, TradeInsights } from "../../api/types";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** "9" → "9ч". */
function formatHourShort(hour: number): string {
  return `${hour}ч`;
}

function displaySymbol(symbol: string): string {
  return symbol.replace(/-USDT$/, "");
}

/** "R/R 1/2 — по тейку 1/2 (50%)." — без разбора причины промаха, чтобы не повторять её в каждой строке. */
function formatPresetOutcome(entry: PresetOutcome): string {
  const hitPct = Math.round(entry.hitRate * 100);
  return `R/R ${entry.preset} — по тейку ${entry.tpCount}/${entry.totalTrades} (${hitPct}%).`;
}

function formatAssetOutcome(entry: { symbol: string; tpCount: number; totalTrades: number }): string {
  const hitPct = Math.round((entry.tpCount / entry.totalTrades) * 100);
  return `${displaySymbol(entry.symbol)} - ${entry.tpCount}/${entry.totalTrades} TP (${hitPct}%)`;
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
  const assetOutcomes = insights.assetOutcomes ?? [];
  const topStopAssets = insights.topStopAssets ?? [];

  const hasAnyData =
    insights.topProfitableHours.length > 0 ||
    insights.topStopHours.length > 0 ||
    assetOutcomes.length > 0 ||
    topStopAssets.length > 0 ||
    insights.dailyTargetHour !== null ||
    insights.presetOutcomes.length > 0;

  if (!hasAnyData) return null;

  return (
    <div className="mx-4 flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <h3 className="text-sm font-medium text-ink">Подсказка</h3>
      <ul className="flex flex-col gap-1.5 text-xs text-slate-600">
        {insights.topProfitableHours.length > 0 && (
          <li>
            Прибыльные часы:{" "}
            {insights.topProfitableHours
              .map((bucket) => `${formatHourShort(bucket.hour)} — ${bucket.tpCount}/${bucket.total} TP`)
              .join(", ")}
          </li>
        )}

        {assetOutcomes.length > 0 && (
          <li>
            <div className="flex flex-col gap-1">
              <p>% прибыльности активов:</p>
              {assetOutcomes.map((entry) => (
                <p key={entry.symbol}>{formatAssetOutcome(entry)}</p>
              ))}
            </div>
          </li>
        )}

        {insights.presetOutcomes.length > 0 && (
          <li>
            <PresetOutcomesList items={insights.presetOutcomes} limit={VISIBLE_PRESETS_LIMIT} />
          </li>
        )}

        {insights.topStopHours.length > 0 && (
          <li>
            Чаще убыточные сделки в:{" "}
            {insights.topStopHours
              .map((bucket) => `${formatHourShort(bucket.hour)} (${bucket.count})`)
              .join(", ")}
          </li>
        )}

        {topStopAssets.length > 0 && (
          <li>
            Чаще убыточные сделки по:{" "}
            {topStopAssets
              .map((entry) => `${displaySymbol(entry.symbol)} (${entry.count})`)
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

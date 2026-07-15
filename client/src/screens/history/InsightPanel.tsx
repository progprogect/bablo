import { useState } from "react";
import type { TradeInsights } from "../../api/types";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** "15" → "15:00–16:00" (перенос через полночь показываем как "23:00–00:00"). */
function formatHourRange(hour: number): string {
  const next = (hour + 1) % 24;
  return `${pad2(hour)}:00–${pad2(next)}:00`;
}

type HourRange = { startHour: number; endHour: number };

/**
 * Склеивает отдельные "пустые" часы в диапазоны, чтобы вместо списка вроде
 * "00:00–01:00, 01:00–02:00, … и ещё 20" показывать "01:00–07:00". Диапазон,
 * упирающийся в полночь с обеих сторон (0 и 23 оба пустые), склеивается в один
 * ночной диапазон — например "22:00–07:00".
 */
function mergeHourRanges(hours: number[]): HourRange[] {
  if (hours.length === 0) return [];

  const sorted = [...new Set(hours)].sort((a, b) => a - b);
  const groups: number[][] = [[sorted[0]!]];
  for (let i = 1; i < sorted.length; i++) {
    const hour = sorted[i]!;
    const lastGroup = groups[groups.length - 1]!;
    if (hour === lastGroup[lastGroup.length - 1]! + 1) {
      lastGroup.push(hour);
    } else {
      groups.push([hour]);
    }
  }

  if (groups.length > 1) {
    const first = groups[0]!;
    const last = groups[groups.length - 1]!;
    if (first[0] === 0 && last[last.length - 1] === 23) {
      groups[0] = [...last, ...first];
      groups.pop();
    }
  }

  return groups.map((group) => ({
    startHour: group[0]!,
    endHour: (group[group.length - 1]! + 1) % 24,
  }));
}

function formatRange(range: HourRange): string {
  return `${pad2(range.startHour)}:00–${pad2(range.endHour)}:00`;
}

const VISIBLE_RANGES_LIMIT = 3;

/** Список диапазонов с раскрытием по кнопке, если он не влезает в отведённый лимит. */
function ExpandableRanges({ ranges }: { ranges: HourRange[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? ranges : ranges.slice(0, VISIBLE_RANGES_LIMIT);
  const hiddenCount = ranges.length - shown.length;

  return (
    <>
      {shown.map(formatRange).join(", ")}
      {hiddenCount > 0 && (
        <>
          {" "}
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            и ещё {hiddenCount}
          </button>
        </>
      )}
      {expanded && ranges.length > VISIBLE_RANGES_LIMIT && (
        <>
          {" "}
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            свернуть
          </button>
        </>
      )}
    </>
  );
}

export function InsightPanel({ insights }: { insights: TradeInsights }) {
  const hasAnyData =
    insights.topProfitableHours.length > 0 ||
    insights.topStopHours.length > 0 ||
    insights.bestAsset !== null ||
    insights.dailyTargetHour !== null ||
    insights.emptyHours.length < 24;

  if (!hasAnyData) return null;

  const emptyRanges = mergeHourRanges(insights.emptyHours);

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

        {emptyRanges.length > 0 && (
          <li>
            Не было открытых сделок: <ExpandableRanges ranges={emptyRanges} />
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

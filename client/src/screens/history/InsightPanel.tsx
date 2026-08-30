import { useState } from "react";
import type { PresetOutcome, TradeInsights } from "../../api/types";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** "R/R 1/2 — по тейку 1/2 (50%)." — без разбора причины промаха, чтобы не повторять её в каждой строке. */
function formatPresetOutcome(entry: PresetOutcome): string {
  const hitPct = Math.round(entry.hitRate * 100);
  return `R/R ${entry.preset} — по тейку ${entry.tpCount}/${entry.totalTrades} (${hitPct}%).`;
}

/** «2ч - 7ч» или одно значение, если все тейки 1/3 шли одинаково по длительности. */
function formatRrHoldDuration(entry: NonNullable<TradeInsights["rrHoldDuration"]>): string {
  const range =
    entry.minHours === entry.maxHours ? `${entry.minHours}ч` : `${entry.minHours}ч - ${entry.maxHours}ч`;
  return `Среднее время отработки сделки R/R ${entry.preset}: ${range}`;
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

/** Торговый день начинается в 7ч МСК (час сброса дня, см. risk-settings) — список часов идёт 7ч…6ч. */
const DAY_START_HOUR = 7;
const HOURS_IN_DAY = 24;

/**
 * Милая галочка у сильных часов: мягкий изумрудный кружок с округлым чеком — вместо
 * тяжёлого эмодзи ✅ (просьба от 30.08.2026). Цвет тот же, что у прибыли в истории.
 */
function StrongHourMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="ml-1 inline-block h-3.5 w-3.5 align-[-2.5px]"
      aria-label="прибыльный час"
    >
      <circle cx="8" cy="8" r="8" className="fill-emerald-100" />
      <path
        d="M4.6 8.4 L7 10.8 L11.4 5.6"
        className="stroke-emerald-600"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Все 24 часа торгового дня подряд (решение от 30.08.2026; раньше показывались только
 * «прибыльные» часы с долей тейков ≥ 50%, отсортированные по силе). Час со сделками —
 * `7ч - 5/7 TP (71%)`, час без сделок — просто `7ч`. Галочка (StrongHourMark) у часов,
 * где тейков СТРОГО больше половины — визуальная метка самых прибыльных часов.
 */
function HoursList({ items }: { items: TradeInsights["hourlyOutcomes"] }) {
  const byHour = new Map(items.map((entry) => [entry.hour, entry]));
  const hours = Array.from({ length: HOURS_IN_DAY }, (_, i) => (DAY_START_HOUR + i) % HOURS_IN_DAY);

  return (
    <li>
      <div className="flex flex-col gap-1">
        <p>Тейки по часам открытия:</p>
        {hours.map((hour) => {
          const entry = byHour.get(hour);
          if (!entry) {
            return (
              <p key={hour} className="text-slate-400">
                {hour}ч
              </p>
            );
          }
          const pct = Math.round((entry.tpCount / entry.total) * 100);
          const isStrong = entry.tpCount / entry.total > 0.5;
          return (
            <p key={hour}>
              {hour}ч - {entry.tpCount}/{entry.total} TP ({pct}%)
              {isStrong && <StrongHourMark />}
            </p>
          );
        })}
      </div>
    </li>
  );
}

export function InsightPanel({ insights }: { insights: TradeInsights }) {
  const hourlyOutcomes = insights.hourlyOutcomes ?? [];
  const rrHoldDuration = insights.rrHoldDuration ?? null;

  const hasAnyData =
    hourlyOutcomes.length > 0 ||
    insights.dailyTargetHour !== null ||
    rrHoldDuration !== null ||
    insights.presetOutcomes.length > 0;

  if (!hasAnyData) return null;

  return (
    <div className="mx-4 flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <h3 className="text-sm font-medium text-ink">Подсказка</h3>
      <ul className="flex flex-col gap-1.5 text-xs text-slate-600">
        {hourlyOutcomes.length > 0 && <HoursList items={hourlyOutcomes} />}

        {insights.presetOutcomes.length > 0 && (
          <li>
            <PresetOutcomesList items={insights.presetOutcomes} limit={VISIBLE_PRESETS_LIMIT} />
          </li>
        )}

        {insights.dailyTargetHour && (
          <li>
            Обычно закрываю дневную цель +{insights.dailyTargetHour.targetR}R к{" "}
            {pad2(insights.dailyTargetHour.hour)}:00
          </li>
        )}

        {rrHoldDuration && <li>{formatRrHoldDuration(rrHoldDuration)}</li>}
      </ul>
    </div>
  );
}

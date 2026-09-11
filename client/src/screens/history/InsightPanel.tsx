import { useState } from "react";
import type { TradeInsights } from "../../api/types";

/** Торговый день начинается в 7ч МСК (час сброса дня, см. risk-settings) — список часов идёт 7ч…6ч. */
const DAY_START_HOUR = 7;
const HOURS_IN_DAY = 24;
/**
 * Сразу показываем 7ч…21ч, ночные 22ч…6ч — по кнопке (просьба от 30.08.2026):
 * ночью торговли почти нет, а хвост из пустых часов растягивал карточку.
 */
const VISIBLE_LAST_HOUR = 21;
const VISIBLE_HOURS_COUNT = VISIBLE_LAST_HOUR - DAY_START_HOUR + 1;

/**
 * Милая галочка у сильных часов: мягкий мятный кружок с округлым чеком — вместо
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
 * где тейков НЕ МЕНЬШЕ половины (ровно 50% тоже считается — уточнение от 30.08.2026) —
 * визуальная метка прибыльных часов.
 */
function HoursList({ items }: { items: TradeInsights["hourlyOutcomes"] }) {
  const [expanded, setExpanded] = useState(false);
  const byHour = new Map(items.map((entry) => [entry.hour, entry]));
  const allHours = Array.from({ length: HOURS_IN_DAY }, (_, i) => (DAY_START_HOUR + i) % HOURS_IN_DAY);
  const hours = expanded ? allHours : allHours.slice(0, VISIBLE_HOURS_COUNT);

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
          const isStrong = entry.tpCount / entry.total >= 0.5;
          return (
            <p key={hour}>
              {hour}ч - {entry.tpCount}/{entry.total} TP ({pct}%)
              {isStrong && <StrongHourMark />}
            </p>
          );
        })}
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="self-start font-medium text-accent underline-offset-2 hover:underline"
        >
          {expanded ? "свернуть" : "показать 22ч–6ч"}
        </button>
      </div>
    </li>
  );
}

/**
 * Карточка-подсказка над списком сделок. С 11.09.2026 в ней остались ТОЛЬКО часы:
 * статистика по пресетам R/R, типичный час дневной цели и «время отработки 1/3»
 * убраны по просьбе пользователя (серверные расчёты удалены вместе с ними).
 */
export function InsightPanel({ insights }: { insights: TradeInsights }) {
  const hourlyOutcomes = insights.hourlyOutcomes ?? [];
  if (hourlyOutcomes.length === 0) return null;

  return (
    <div className="mx-4 flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <h3 className="text-sm font-medium text-ink">Подсказка</h3>
      <ul className="flex flex-col gap-1.5 text-xs text-slate-600">
        <HoursList items={hourlyOutcomes} />
      </ul>
    </div>
  );
}

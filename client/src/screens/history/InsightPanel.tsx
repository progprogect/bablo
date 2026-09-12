import { useEffect, useState } from "react";
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
/** Час считается прибыльным, если тейков НЕ МЕНЬШЕ половины (ровно 50% тоже — уточнение от 30.08.2026). */
const STRONG_SHARE = 0.5;

/** Час со сделками, но без тейков (0%), всё равно рисуем тонкой полоской — иначе он
 *  неотличим от часа, в который сделок не было вовсе (так же сделано в детализации месяца). */
const MIN_BAR_PCT = 3;

const HOUR_MS = 3_600_000;

function localHour(atMs: number, tzOffsetMinutes: number): number {
  return new Date(atMs + tzOffsetMinutes * 60_000).getUTCHours();
}

/**
 * Текущий час в таймзоне риск-плана (её же отдаёт /api/stats): подсветка «сейчас» должна
 * совпадать с часами гистограммы, а время устройства может быть другим. Пересчитывается
 * на границе часа, чтобы подсветка переезжала без перезагрузки экрана.
 */
function useCurrentHour(tzOffsetMinutes: number): number {
  const [hour, setHour] = useState(() => localHour(Date.now(), tzOffsetMinutes));

  useEffect(() => {
    let timer = 0;
    const tick = () => {
      const now = Date.now();
      setHour(localHour(now, tzOffsetMinutes));
      // Граница часа: смещение таймзоны кратно минутам, поэтому считаем её по сдвинутой шкале.
      const shifted = now + tzOffsetMinutes * 60_000;
      const msIntoHour = ((shifted % HOUR_MS) + HOUR_MS) % HOUR_MS;
      timer = window.setTimeout(tick, HOUR_MS - msIntoHour + 1_000);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [tzOffsetMinutes]);

  return hour;
}

/** Полоски растут от нуля при появлении карточки — иначе гистограмма «прыгает» готовой. */
function useGrown(): boolean {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setGrown(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);
  return grown;
}

/**
 * Милая галочка у сильных часов: мягкий мятный кружок с округлым чеком — вместо
 * тяжёлого эмодзи ✅ (просьба от 30.08.2026). Цвет тот же, что у прибыли в истории.
 */
function StrongHourMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-label="прибыльный час">
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
 * Час закрыт правилом убыточных часов (docs/RISK_ENGINE.md): замок вместо галочки —
 * галочка и замок взаимоисключающи, блокируются только часы с винрейтом ≤ 30%.
 */
function BlockedHourMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-label="час закрыт для торговли">
      <circle cx="8" cy="8" r="8" className="fill-slate-200" />
      <path
        d="M6 7.2V5.9a2 2 0 0 1 4 0V7.2"
        className="stroke-slate-500"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
      <rect x="4.9" y="7.2" width="6.2" height="4.6" rx="1.3" className="fill-slate-500" />
    </svg>
  );
}

type HourEntry = TradeInsights["hourlyOutcomes"][number];

/**
 * Строка гистограммы: час, полоса доли тейков относительно 100%, счёт и процент.
 * Прибыльные часы (≥ STRONG_SHARE) — мятная полоса и галочка, остальные — нейтрально-серая
 * (не красная: слабые часы не должны тянуть на себя внимание — просьба от 11.09.2026).
 * Засечка посередине дорожки — те самые 50%. Текущий час подсвечен акцентом.
 */
function HourBar({
  hour,
  entry,
  isNow,
  isBlocked,
  grown,
}: {
  hour: number;
  entry: HourEntry | undefined;
  isNow: boolean;
  isBlocked: boolean;
  grown: boolean;
}) {
  const total = entry?.total ?? 0;
  const share = total > 0 ? entry!.tpCount / total : null;
  const pct = share !== null ? Math.round(share * 100) : null;
  const isStrong = share !== null && share >= STRONG_SHARE;

  return (
    <li
      aria-current={isNow ? "time" : undefined}
      className={`flex items-center gap-1.5 rounded-lg py-1 pl-1 pr-1.5 ${
        isNow ? "bg-accent/[0.07] ring-1 ring-inset ring-accent/25" : ""
      }`}
    >
      <span className="flex w-1.5 shrink-0 justify-center">
        {isNow && (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="sr-only">сейчас</span>
          </>
        )}
      </span>
      <span
        className={`w-6 shrink-0 text-[11px] tabular-nums ${
          isNow
            ? "font-semibold text-accent"
            : total > 0
              ? "text-slate-600"
              : "text-slate-400"
        }`}
      >
        {hour}ч
      </span>
      <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-line/70">
        {/* Засечка ровно на половине дорожки — граница «прибыльного» часа. Лежит ПОД полосой:
            у сильных часов её закрывает заливка, у слабых видно, сколько не дотянули. */}
        <span className="absolute inset-y-0 left-1/2 w-px bg-slate-900/10" />
        {pct !== null && (
          <span
            className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out ${
              isStrong
                ? "bg-gradient-to-r from-emerald-400 to-emerald-500"
                : "bg-gradient-to-r from-slate-300 to-slate-400"
            }`}
            style={{ width: `${grown ? Math.max(pct, MIN_BAR_PCT) : 0}%` }}
          />
        )}
      </span>
      <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-slate-400">
        {total > 0 ? `${entry!.tpCount}/${total}` : "—"}
      </span>
      <span
        className={`w-8 shrink-0 text-right text-[11px] font-medium tabular-nums ${
          isStrong ? "text-emerald-600" : "text-slate-500"
        }`}
      >
        {pct !== null ? `${pct}%` : ""}
      </span>
      <span className="w-3.5 shrink-0">
        {isBlocked ? <BlockedHourMark /> : isStrong ? <StrongHourMark /> : null}
      </span>
    </li>
  );
}

/**
 * Все 24 часа торгового дня подряд, 7ч…6ч (решение от 30.08.2026). С 11.09.2026 это не
 * текст, а горизонтальная гистограмма: длина полосы — доля тейков от 100%, так сильные и
 * слабые часы видно, не читая цифр.
 */
function HoursChart({
  items,
  tzOffsetMinutes,
  blockedHours,
}: {
  items: HourEntry[];
  tzOffsetMinutes: number;
  blockedHours: number[];
}) {
  const [expanded, setExpanded] = useState(false);
  const currentHour = useCurrentHour(tzOffsetMinutes);
  const grown = useGrown();

  const blocked = new Set(blockedHours);
  const byHour = new Map(items.map((entry) => [entry.hour, entry]));
  const allHours = Array.from({ length: HOURS_IN_DAY }, (_, i) => (DAY_START_HOUR + i) % HOURS_IN_DAY);
  const hours = expanded ? allHours : allHours.slice(0, VISIBLE_HOURS_COUNT);

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-slate-500">Тейки по часам открытия</p>
      <ul className="-mx-1 flex flex-col">
        {hours.map((hour) => (
          <HourBar
            key={hour}
            hour={hour}
            entry={byHour.get(hour)}
            isNow={hour === currentHour}
            isBlocked={blocked.has(hour)}
            grown={grown}
          />
        ))}
      </ul>
      {blocked.size > 0 && (
        <p className="text-[11px] text-slate-400">Замок — час закрыт, сделки в нём не открыть</p>
      )}
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="self-start text-xs font-medium text-accent underline-offset-2 hover:underline"
      >
        {expanded ? "свернуть" : "показать 22ч–6ч"}
      </button>
    </div>
  );
}

/**
 * Карточка-подсказка над списком сделок. С 11.09.2026 в ней остались ТОЛЬКО часы:
 * статистика по пресетам R/R, типичный час дневной цели и «время отработки 1/3»
 * убраны по просьбе пользователя (серверные расчёты удалены вместе с ними).
 */
export function InsightPanel({
  insights,
  tzOffsetMinutes,
  blockedHours,
}: {
  insights: TradeInsights;
  tzOffsetMinutes: number;
  blockedHours: number[];
}) {
  const hourlyOutcomes = insights.hourlyOutcomes ?? [];
  if (hourlyOutcomes.length === 0) return null;

  return (
    <div className="mx-4 flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <h3 className="text-sm font-medium text-ink">Подсказка</h3>
      <HoursChart
        items={hourlyOutcomes}
        tzOffsetMinutes={tzOffsetMinutes}
        blockedHours={blockedHours}
      />
    </div>
  );
}

import type { MonthlyRRPresetCount, MonthlyStat } from "../../api/types";
import { formatSignedR, formatSignedRValue, trimTrailingZeros } from "../../lib/format";

export const MONTH_LABELS = [
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

/** Числа, которые показывает карточка статистики, — без привязки к периоду. */
export type StatCardData = {
  resultPct: number | null;
  sumR: number;
  totalTrades: number;
  winRate: number;
  tpCount: number;
  slCount: number;
  beCount: number;
  tradingDays: number;
  byRRPreset: MonthlyRRPresetCount[];
  sumPositiveR: number;
  sumNegativeR: number;
};

/**
 * Оттенок карточки. «Итоги года» стоят в одном списке с месяцами, и белая карточка
 * терялась среди одинаковых белых (просьба пользователя от 25.10.2026): годовая слегка
 * подсвечена — другой уровень обобщения видно до чтения заголовка. Подсветка тихая, на
 * уровне фона: цвет в этом приложении значит исход сделки (зелёный/красный) или
 * блокировку (янтарный), и занимать его ради «это год» нельзя.
 *
 * Тон тёплый (токены highlight/highlight-line, см. index.css), а не голубой акцентный:
 * первый вариант был на акценте и на тёплом айвори-фоне читался холодновато-серым —
 * пользователь попросил мягче (25.10.2026). Крем лежит между белой карточкой и фоном,
 * поэтому карточка выделяется, но не спорит с палитрой.
 */
const TONES = {
  card: { card: "border-line bg-card", divider: "border-line" },
  accent: { card: "border-highlight-line bg-highlight", divider: "border-highlight-line" },
} as const;

export type StatCardTone = keyof typeof TONES;

/**
 * Общее тело карточки статистики за период — месяц (MonthlyStatCard) и год
 * (YearlyStatCard, 23.10.2026) различаются только заголовком, данными, сноской и
 * оттенком, поэтому вёрстка одна: разъехаться карточки не могут.
 */
export function StatCardBody({
  title,
  data,
  footnote,
  tone = "card",
}: {
  title: string;
  data: StatCardData;
  /** Пояснение внизу карточки — например, почему нет % или с какого месяца он считается. */
  footnote?: string | null;
  tone?: StatCardTone;
}) {
  const toneClasses = TONES[tone];
  const isProfit = data.resultPct !== null ? data.resultPct > 0 : data.sumR > 0;
  const isLoss = data.resultPct !== null ? data.resultPct < 0 : data.sumR < 0;
  const resultColorClass = isProfit ? "text-emerald-600" : isLoss ? "text-red-600" : "text-slate-600";

  return (
    <div className={`flex flex-col gap-3 rounded-2xl border p-4 shadow-sm ${toneClasses.card}`}>
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        <div className="flex items-baseline gap-2">
          <span className={`text-base font-semibold ${resultColorClass}`}>
            {data.resultPct !== null ? formatSignedPercent(data.resultPct) : "—"}
          </span>
          {/* Сумма R — до десятых, как и R в карточках сделок (см. lib/format.ts). */}
          <span className="text-xs text-slate-500">{formatSignedR(data.sumR)}</span>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-y-2 text-sm">
        <Row label="Всего сделок" value={String(data.totalTrades)} />
        <Row label="Винрейт" value={`${trimTrailingZeros(data.winRate * 100)}%`} />
        <Row label="TP / SL / Б/У" value={`${data.tpCount} / ${data.slCount} / ${data.beCount}`} />
        <Row label="Торговых дней" value={String(data.tradingDays)} />
      </dl>

      {data.byRRPreset.length > 0 && (
        <div className={`flex items-start justify-between gap-3 border-t pt-2.5 ${toneClasses.divider}`}>
          <div className="flex flex-1 flex-wrap gap-x-2.5 gap-y-1.5">
            {data.byRRPreset.map((entry) => (
              <div key={entry.preset} className="flex min-w-[26px] flex-col items-center">
                <span className="text-[10px] text-slate-400">{presetRLabel(entry.preset)}</span>
                <span className="text-xs font-medium text-ink">{entry.count}</span>
              </div>
            ))}
          </div>
          <div className={`flex shrink-0 flex-col items-center border-l pl-2.5 ${toneClasses.divider}`}>
            <span className="text-[10px] text-slate-400">+R / −R</span>
            <span className="text-xs font-medium">
              <span className="text-emerald-600">{formatSignedRValue(data.sumPositiveR)}</span>
              <span className="text-slate-400"> / </span>
              <span className="text-red-600">{formatSignedRValue(data.sumNegativeR)}</span>
            </span>
          </div>
        </div>
      )}

      {footnote && <p className="text-xs text-slate-400">{footnote}</p>}
    </div>
  );
}

export function MonthlyStatCard({ stat }: { stat: MonthlyStat }) {
  return (
    <StatCardBody
      title={`${MONTH_LABELS[stat.month - 1]} ${stat.year}`}
      data={stat}
      footnote={
        stat.resultPct === null
          ? "% к депозиту недоступен — нет снимка баланса на начало месяца"
          : null
      }
    />
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

import type { EquitySnapshot } from "../../api/types";
import { formatPrice } from "../../lib/format";

/**
 * Ручной SVG-график без внешних зависимостей — единственная кривая линия, поэтому
 * подключать библиотеку графиков ради этого избыточно (см. явное исключение из
 * принципа "без графиков" в docs/PROJECT.md — только для этого конкретного случая).
 */
const WIDTH = 320;
const HEIGHT = 180;
const PADDING = { top: 16, right: 12, bottom: 12, left: 12 };

/**
 * Золото для отметок вывода (просьба пользователя от 18.10.2026) — литералом, а не
 * токеном темы: в палитре золота нет, а заводить ради одной точки пятый смысловой цвет
 * незачем. Металлическое #D4AF37, а не #FFD700: чистый жёлтый на белой карточке
 * выглядит кислотным и спорит с акцентной линией.
 */
const GOLD = "#D4AF37";

export type WithdrawalMark = {
  /** ISO-таймстемп подтверждённого вывода. */
  at: string;
  amountUsd: number;
};

function formatShortDate(dateKey: string): string {
  const parts = dateKey.split("-");
  return `${parts[2]}.${parts[1]}`;
}

/**
 * Сумма вывода в подсказке — с запятой и разрядами, как во всех денежных строках
 * приложения («140,00 USDT»). `formatPrice` здесь не подходит: это `toFixed`, он даёт
 * «140.00» с точкой, и подсказка выбивалась бы из остального интерфейса.
 */
function formatWithdrawalUsd(value: number): string {
  return value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Таймстемп → ключ дня снимка (YYYY-MM-DD) в ЛОКАЛЬНОЙ зоне устройства. */
function localDateKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Индекс снимка, к которому привязывается отметка вывода.
 *
 * Ось X у графика — НЕ время, а порядковый номер снимка (снимки равномерно распределены
 * по ширине), поэтому отметку нельзя поставить «по дате» — только на точку снимка. Берём
 * снимок того же дня, а если его нет (приложение в тот день не открывали — снимок
 * создаётся лениво при первой загрузке дашборда), ближайший ПРЕДШЕСТВУЮЩИЙ: вывод
 * случился не раньше него. Вывод до первого снимка показать не на чем — `null`.
 *
 * Сравнение строк «YYYY-MM-DD» лексикографическое, что для этого формата равно
 * сравнению дат. Снимки приходят по возрастанию даты (listEquitySnapshots).
 */
function snapshotIndexFor(dateKey: string, snapshots: EquitySnapshot[]): number | null {
  if (dateKey === "") return null;
  let found: number | null = null;
  for (let index = 0; index < snapshots.length; index += 1) {
    if (snapshots[index]!.date <= dateKey) found = index;
    else break;
  }
  return found;
}

export function EquityChart({
  snapshots,
  withdrawals = [],
}: {
  snapshots: EquitySnapshot[];
  /** Подтверждённые выводы — золотые точки на линии. */
  withdrawals?: WithdrawalMark[];
}) {
  if (snapshots.length < 2) {
    return (
      <p className="py-10 text-center text-sm text-slate-500">
        Пока недостаточно данных — график появится через несколько дней использования
        приложения, когда накопится больше снимков баланса.
      </p>
    );
  }

  const values = snapshots.map((snapshot) => snapshot.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const innerWidth = WIDTH - PADDING.left - PADDING.right;
  const innerHeight = HEIGHT - PADDING.top - PADDING.bottom;

  const points = snapshots.map((snapshot, index) => {
    const x = PADDING.left + (index / (snapshots.length - 1)) * innerWidth;
    const y = PADDING.top + innerHeight - ((snapshot.equity - min) / range) * innerHeight;
    return { x, y };
  });

  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const baseline = (PADDING.top + innerHeight).toFixed(1);
  const areaPath = `${linePath} L${points[points.length - 1]!.x.toFixed(1)},${baseline} L${points[0]!.x.toFixed(1)},${baseline} Z`;

  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const changePct = first.equity > 0 ? ((last.equity - first.equity) / first.equity) * 100 : 0;
  const changeColorClass = changePct > 0 ? "text-emerald-600" : changePct < 0 ? "text-red-600" : "text-slate-600";
  const lastPoint = points[points.length - 1]!;

  // Несколько выводов в один день дают один и тот же снимок — точки легли бы друг на
  // друга. Складываем их суммы в одну отметку: на графике это один момент времени.
  const marksByIndex = new Map<number, { amountUsd: number; dateKey: string }>();
  for (const withdrawal of withdrawals) {
    const dateKey = localDateKey(withdrawal.at);
    const index = snapshotIndexFor(dateKey, snapshots);
    if (index === null) continue;
    const existing = marksByIndex.get(index);
    marksByIndex.set(index, {
      amountUsd: (existing?.amountUsd ?? 0) + withdrawal.amountUsd,
      dateKey: existing?.dateKey ?? dateKey,
    });
  }
  const marks = [...marksByIndex.entries()].map(([index, mark]) => ({ index, ...mark }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-slate-500">
          {formatShortDate(first.date)} — {formatShortDate(last.date)}
        </span>
        <span className={`text-sm font-semibold ${changeColorClass}`}>
          {changePct > 0 ? "+" : ""}
          {changePct.toFixed(1)}%
        </span>
      </div>

      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" preserveAspectRatio="none">
        <path d={areaPath} className="fill-accent/10" stroke="none" />
        <path d={linePath} fill="none" className="stroke-accent" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={lastPoint.x} cy={lastPoint.y} r={3.5} className="fill-accent" />
        {/* Отметки вывода рисуются ПОСЛЕ точки последнего снимка: если вывод был в
            последний день, важнее показать вывод, а не то, что это край графика. */}
        {marks.map((mark) => {
          const point = points[mark.index]!;
          return (
            <circle
              key={mark.index}
              cx={point.x}
              cy={point.y}
              r={4}
              fill={GOLD}
              stroke="white"
              strokeWidth={1.5}
            >
              {/* Нативная подсказка — бесплатно на десктопе, на телефоне просто не мешает. */}
              <title>{`Вывод ${formatWithdrawalUsd(mark.amountUsd)} USDT · ${formatShortDate(mark.dateKey)}`}</title>
            </circle>
          );
        })}
      </svg>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>Мин {formatPrice(min, 0)} USDT</span>
        <span>Макс {formatPrice(max, 0)} USDT</span>
      </div>

      {/* Легенда только когда есть что пояснять: точка без подписи — загадка, а пустая
          строка «выводов нет» ничего не сообщает. */}
      {marks.length > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0" aria-hidden="true">
            <circle cx="5" cy="5" r="4" fill={GOLD} />
          </svg>
          <span>Вывод прибыли</span>
        </div>
      )}
    </div>
  );
}

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

function formatShortDate(dateKey: string): string {
  const parts = dateKey.split("-");
  return `${parts[2]}.${parts[1]}`;
}

export function EquityChart({ snapshots }: { snapshots: EquitySnapshot[] }) {
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
      </svg>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>Мин {formatPrice(min, 0)} USDT</span>
        <span>Макс {formatPrice(max, 0)} USDT</span>
      </div>
    </div>
  );
}

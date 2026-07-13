import type { Trade } from "../../api/types";

function formatPrice(value: string | null): string {
  return value !== null ? Number(value).toString() : "—";
}

/** MFE в R — насколько далеко в свою пользу доходила цена относительно риска сделки (Этап 7). */
function mfeInR(trade: Trade): string {
  if (trade.mfePrice === null || trade.entryPrice === null || trade.slPrice === null) return "—";
  const entry = Number(trade.entryPrice);
  const sl = Number(trade.slPrice);
  const mfe = Number(trade.mfePrice);
  const riskDistance = Math.abs(entry - sl);
  if (riskDistance === 0) return "—";
  const favorableDistance = trade.side === "long" ? mfe - entry : entry - mfe;
  return `${(favorableDistance / riskDistance).toFixed(2)}R`;
}

function signalLabels(signals: Record<string, unknown> | null): string {
  if (!signals || Object.keys(signals).length === 0) return "—";
  return Object.keys(signals).join(", ");
}

/**
 * Детальная строка расширенного трекинга: вход/SL/TP, MFE (в цене и в R), пересечение
 * безубытка, сигналы. Набор сигналов пока не определён (см. docs/RISK_ENGINE.md) — поле
 * зарезервировано и отображается как "—", пока их набор не согласован.
 */
export function TrackingRow({ trade }: { trade: Trade }) {
  const displayName = trade.symbol.replace(/-USDT$/, "");

  return (
    <div className="mx-4 flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 text-xs shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink">{displayName}</span>
        {trade.beCrossed && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700">
            Было в безубытке
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 text-slate-500">
        <Field label="Вход" value={formatPrice(trade.entryPrice)} />
        <Field label="SL" value={formatPrice(trade.slPrice)} />
        <Field label="TP" value={formatPrice(trade.tpPrice)} />
        <Field label="Закрытие" value={formatPrice(trade.closePrice)} />
        <Field label="MFE" value={formatPrice(trade.mfePrice)} />
        <Field label="MFE, R" value={mfeInR(trade)} />
      </div>

      {trade.partialTpPrice && (
        <div className="border-t border-line pt-2 text-slate-500">
          Частичная фиксация 70% на {formatPrice(trade.partialTpPrice)}:{" "}
          <span className="text-ink">
            {trade.partialTpFilledAt
              ? `сработала по ${formatPrice(trade.partialTpFillPrice)}`
              : "не сработала"}
          </span>
        </div>
      )}

      <div className="border-t border-line pt-2 text-slate-500">
        Сигналы: <span className="text-slate-600">{signalLabels(trade.signals)}</span>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-slate-500">{label}</span>
      <span className="text-ink">{value}</span>
    </div>
  );
}

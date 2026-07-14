import type { Trade } from "../../api/types";
import { formatSignedUsd, trimTrailingZeros } from "../../lib/format";

/**
 * "external" (закрыта на BingX не через приложение, обнаружено постфактум) показываем
 * так же, как "manual" — пользователю не важно, каким способом технически определилась
 * ручная закрытие, важен сам факт.
 */
const CLOSE_REASON_LABELS: Record<string, string> = {
  sl: "По стопу",
  tp: "По тейку",
  manual: "Вручную",
  external: "Вручную",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(openedAt: string, closedAt: string | null): string {
  if (!closedAt) return "—";
  const ms = new Date(closedAt).getTime() - new Date(openedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

/** R/R сделки: сохранённый пресет, либо вычисленный из entry/SL/TP (если TP выставлялся вручную). */
function riskReward(trade: Trade): string {
  if (trade.rrPreset) return trade.rrPreset;
  if (!trade.entryPrice || !trade.slPrice || !trade.tpPrice) return "—";
  const entry = Number(trade.entryPrice);
  const sl = Number(trade.slPrice);
  const tp = Number(trade.tpPrice);
  const risk = Math.abs(entry - sl);
  if (risk === 0) return "—";
  return `1/${trimTrailingZeros(Math.abs(tp - entry) / risk)}`;
}

/** Реализованный результат в USDT: resultR × риск сделки в $. */
function realizedPnlUsd(trade: Trade): number | null {
  if (trade.resultR === null || trade.riskUsd === null) return null;
  return Number(trade.resultR) * Number(trade.riskUsd);
}

export function TradeRow({ trade }: { trade: Trade }) {
  const displayName = trade.symbol.replace(/-USDT$/, "");
  const pnlUsd = realizedPnlUsd(trade);
  const isProfit = pnlUsd !== null && pnlUsd > 0;
  const isLoss = pnlUsd !== null && pnlUsd < 0;

  return (
    <div className="mx-4 flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{displayName}</span>
          <span
            className={
              trade.side === "long"
                ? "rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-600"
                : "rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600"
            }
          >
            {trade.side === "long" ? "Лонг" : "Шорт"}
          </span>
          {trade.partialTpFilledAt && (
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
              частичная 70%
            </span>
          )}
        </div>
        <span className="text-xs text-slate-500">{formatDate(trade.openedAt)}</span>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {formatDuration(trade.openedAt, trade.closedAt)} · R/R {riskReward(trade)} ·{" "}
          {CLOSE_REASON_LABELS[trade.closeReason ?? ""] ?? "—"}
        </span>
        <span
          className={
            isProfit
              ? "text-sm font-medium text-emerald-600"
              : isLoss
                ? "text-sm font-medium text-red-600"
                : "text-sm font-medium text-slate-600"
          }
        >
          {formatSignedUsd(pnlUsd)}
        </span>
      </div>
    </div>
  );
}

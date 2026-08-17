import type { Trade } from "../../api/types";
import { formatSignedUsd, trimTrailingZeros } from "../../lib/format";

/**
 * Подпись по фактическому исходу с сервера (history/outcome.ts), а не по типу
 * сработавшего ордера: стоп, уведённый в прибыль ночным правилом, — это тейк, и в
 * статистике он тоже считается тейком. Для "manual"/"external" (закрыта вручную или
 * обнаружено постфактум на BingX) подписи нет: длительность и R/R уже понятны
 * без дополнительного слова.
 */
const OUTCOME_LABELS: Record<string, string> = {
  sl: "По стопу",
  tp: "По тейку",
  be: "Безубыток",
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

/**
 * Фактический R сделки — «сколько R она принесла». Берём с сервера (statsResultR: он же
 * идёт в статистику, с учётом ручного столбца R из админки), иначе из resultR.
 * Раньше в карточке был только ПЛАН (R/R 1/2), и по истории нельзя было понять,
 * что сделка реально дала.
 */
function factualR(trade: Trade): string | null {
  const raw = trade.statsResultR ?? (trade.resultR !== null ? Number(trade.resultR) : null);
  if (raw === null || !Number.isFinite(raw)) return null;
  const rounded = Math.round(raw * 100) / 100;
  return `${rounded > 0 ? "+" : ""}${trimTrailingZeros(rounded)}R`;
}

/** Реализованный результат в USDT: resultR × риск сделки в $. */
function realizedPnlUsd(trade: Trade): number | null {
  if (trade.resultR === null || trade.riskUsd === null) return null;
  return Number(trade.resultR) * Number(trade.riskUsd);
}

export function TradeRow({ trade }: { trade: Trade }) {
  const displayName = trade.symbol.replace(/-USDT$/, "");
  const pnlUsd = realizedPnlUsd(trade);
  const resultR = factualR(trade);
  const isProfit = pnlUsd !== null && pnlUsd > 0;
  const isLoss = pnlUsd !== null && pnlUsd < 0;
  // Старые ответы API без outcome — откат на closeReason, чтобы подпись не пропала.
  const outcome = trade.outcome ?? trade.closeReason ?? undefined;
  const closeReasonLabel = outcome ? OUTCOME_LABELS[outcome] : undefined;

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
        {/* Только факт: сколько R сделка реально дала. План (пресет R/R) в карточке не
            показываем — он ничего не говорит о результате, а место занимает. */}
        <span>
          {formatDuration(trade.openedAt, trade.closedAt)}
          {resultR ? ` · ${resultR}` : ""}
          {closeReasonLabel ? ` · ${closeReasonLabel}` : ""}
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

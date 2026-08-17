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
 * R/R сделки. Приоритет:
 * 1. ручной столбец R из админки (statsRrPreset) — если пользователь задал R сделки,
 *    он должен видеть его и здесь, а не расходящееся значение;
 * 2. сохранённый пресет (rrPreset);
 * 3. расчёт от ИСХОДНОГО риска сделки (riskUsd / quantity) — так считается R/R при TP,
 *    выставленном вручную.
 *
 * Пункт 3 раньше считался от текущего SL (`|вход − SL|`), и это врало: стоп мог быть
 * подтянут ночным правилом или после частичной фиксации, знаменатель схлопывался, и
 * сделка на ~2R показывалась как «R/R 1/19.65». Исходный риск в riskUsd зафиксирован
 * на момент открытия и не меняется, поэтому считаем от него.
 */
function riskReward(trade: Trade): string {
  const override = trade.statsRrPreset;
  if (override && override !== "none") return override;
  if (trade.rrPreset) return trade.rrPreset;
  if (!trade.entryPrice || !trade.tpPrice) return "—";
  const entry = Number(trade.entryPrice);
  const tp = Number(trade.tpPrice);
  const riskUsd = Number(trade.riskUsd);
  const quantity = Number(trade.quantity);

  if (riskUsd > 0 && quantity > 0) {
    const riskDistance = riskUsd / quantity;
    if (riskDistance > 0) return `1/${trimTrailingZeros(Math.abs(tp - entry) / riskDistance)}`;
  }

  // Нет риска в записи (старые сделки) — откат на расчёт по SL.
  if (!trade.slPrice) return "—";
  const risk = Math.abs(entry - Number(trade.slPrice));
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
        <span>
          {formatDuration(trade.openedAt, trade.closedAt)} · R/R {riskReward(trade)}
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

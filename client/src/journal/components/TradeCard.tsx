import { Link } from "react-router-dom";
import { formatPrice, formatSignedUsd, trimTrailingZeros } from "../../lib/format";
import type { JournalTradeCard, TradeOutcome } from "../types";

/** Подписи исхода — те же, что в Истории терминала (для manual/external подписи нет). */
export const OUTCOME_LABELS: Partial<Record<TradeOutcome, string>> = {
  sl: "По стопу",
  tp: "По тейку",
  be: "Безубыток",
};

export function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function SideBadge({ side }: { side: "long" | "short" }) {
  return (
    <span
      className={
        side === "long"
          ? "rounded-full bg-positive/10 px-2 py-0.5 text-[11px] font-medium text-positive"
          : "rounded-full bg-negative/10 px-2 py-0.5 text-[11px] font-medium text-negative"
      }
    >
      {side === "long" ? "Лонг" : "Шорт"}
    </span>
  );
}

/**
 * Выжимка сделки в две строки: время закрытия и сумма, уровни входа (стоп/тейк ПРИ ВХОДЕ,
 * R/R по плану) и исход. Общая разметка ленты «Разбора» и шапки детали сделки — экраны
 * показывают одно и то же одинаково.
 */
export function TradeSummary({ trade }: { trade: JournalTradeCard }) {
  const displayName = trade.symbol.replace(/-USDT$/, "");
  const isProfit = trade.resultUsd !== null && trade.resultUsd > 0;
  const isLoss = trade.resultUsd !== null && trade.resultUsd < 0;
  const outcomeLabel = OUTCOME_LABELS[trade.outcome];

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{displayName}</span>
          <SideBadge side={trade.side} />
          <span className="text-xs text-muted">{formatTime(trade.closedAt)}</span>
        </div>
        <span
          className={`text-sm font-semibold ${isProfit ? "text-positive" : isLoss ? "text-negative" : "text-ink"}`}
        >
          {formatSignedUsd(trade.resultUsd)}
        </span>
      </div>

      <div className="flex items-center justify-between text-xs text-muted">
        <span>
          SL {formatPrice(trade.initialSlPrice)} · TP {formatPrice(trade.plannedTpPrice)}
          {trade.plannedRR !== null ? ` · R/R 1/${trimTrailingZeros(trade.plannedRR, 1)}` : ""}
        </span>
        {outcomeLabel && <span>{outcomeLabel}</span>}
      </div>
    </>
  );
}

/**
 * Карточка сделки в ленте «Разбора»: дата уже в заголовке группы, поэтому здесь — время,
 * уровни входа и факт закрытия. Геометрия — как у карточек Истории терминала, палитра —
 * токенами темы.
 */
export function TradeCard({
  trade,
  categoryName,
  showCategory,
}: {
  trade: JournalTradeCard;
  categoryName: string | null;
  /** Чип категории показывается только в смешанной ленте «Все». */
  showCategory: boolean;
}) {
  return (
    <Link
      to={`/trades/${trade.id}`}
      className="mx-4 flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 shadow-sm"
    >
      <TradeSummary trade={trade} />

      {showCategory && (
        <div className="flex items-center justify-between">
          {trade.categoryId !== null && categoryName ? (
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
              {categoryName}
            </span>
          ) : (
            <span className="rounded-full bg-line/60 px-2 py-0.5 text-[11px] font-medium text-muted">
              Неразобранная
            </span>
          )}
        </div>
      )}
    </Link>
  );
}

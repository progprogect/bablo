import { useEffect, useState } from "react";
import {
  ApiError,
  getUnclassifiedTrades,
  setTradeCloseReasonRequest,
} from "../../api/client";
import type { Trade } from "../../api/types";
import { formatSignedUsd } from "../../lib/format";

const CLOSE_KIND_LABELS: Record<string, string> = {
  external: "на BingX",
  manual: "вручную",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pnlUsd(trade: Trade): number | null {
  if (trade.resultR === null || trade.riskUsd === null) return null;
  return Number(trade.resultR) * Number(trade.riskUsd);
}

/**
 * Админ: история сделок без SL/TP (закрыты на бирже мимо приложения или кнопкой «Закрыть»)
 * и ручная пометка как стоп/тейк — чтобы инсайты и дневные лимиты считали их правильно.
 */
export function TradeCloseReasonSection() {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function reload() {
    getUnclassifiedTrades()
      .then(setTrades)
      .catch((err) => {
        setTrades([]);
        setError(err instanceof ApiError ? err.message : "Не удалось загрузить сделки");
      });
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleSetReason(tradeId: number, closeReason: "sl" | "tp") {
    setError(null);
    setNotice(null);
    setBusyId(tradeId);
    try {
      await setTradeCloseReasonRequest(tradeId, closeReason);
      setNotice(closeReason === "sl" ? "Помечено как стоп" : "Помечено как тейк");
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div>
        <h2 className="text-sm font-medium text-ink">Классификация сделок</h2>
        <p className="mt-1 text-xs text-slate-500">
          Сделки, закрытые на BingX мимо приложения или вручную — без метки SL/TP. Выберите стоп
          или тейк, чтобы учесть их в подсказках и дневных лимитах.
        </p>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
      {notice && <p className="text-xs text-emerald-600">{notice}</p>}

      {trades === null ? (
        <p className="text-xs text-slate-500">Загрузка…</p>
      ) : trades.length === 0 ? (
        <p className="text-xs text-slate-500">Нет сделок без классификации SL/TP.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {trades.map((trade) => {
            const pnl = pnlUsd(trade);
            const kind = trade.closeReason ? CLOSE_KIND_LABELS[trade.closeReason] ?? trade.closeReason : "—";
            const busy = busyId === trade.id;
            return (
              <li
                key={trade.id}
                className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-3 py-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-ink">
                      {trade.symbol.replace(/-USDT$/, "")}{" "}
                      <span className="font-normal text-slate-500">
                        {trade.side === "long" ? "лонг" : "шорт"} · {kind}
                      </span>
                    </p>
                    <p className="text-xs text-slate-500">{formatDate(trade.closedAt ?? trade.openedAt)}</p>
                  </div>
                  <p
                    className={
                      pnl !== null && pnl > 0
                        ? "text-sm font-medium text-emerald-600"
                        : pnl !== null && pnl < 0
                          ? "text-sm font-medium text-red-600"
                          : "text-sm text-slate-500"
                    }
                  >
                    {formatSignedUsd(pnl)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleSetReason(trade.id, "sl")}
                    className="flex-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-xs font-medium text-red-700 disabled:opacity-50"
                  >
                    {busy ? "…" : "Стоп"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleSetReason(trade.id, "tp")}
                    className="flex-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs font-medium text-emerald-700 disabled:opacity-50"
                  >
                    {busy ? "…" : "Тейк"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

import { useEffect, useState } from "react";
import { ApiError, getStats, getTradeHistory } from "../api/client";
import type { Trade, TimeOfDayStats } from "../api/types";
import { InsightPanel } from "./history/InsightPanel";
import { TradeRow } from "./history/TradeRow";
import { TrackingRow } from "./history/TrackingRow";

const PAGE_SIZE = 20;

type Tab = "trades" | "stats";

export function History() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<TimeOfDayStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [tab, setTab] = useState<Tab>("trades");

  useEffect(() => {
    Promise.all([getTradeHistory(PAGE_SIZE, 0), getStats()])
      .then(([history, statsResponse]) => {
        setTrades(history.trades);
        setTotal(history.total);
        setStats(statsResponse);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить историю"));
  }, []);

  async function loadMore() {
    setIsLoadingMore(true);
    try {
      const next = await getTradeHistory(PAGE_SIZE, trades.length);
      setTrades((current) => [...current, ...next.trades]);
      setTotal(next.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить историю");
    } finally {
      setIsLoadingMore(false);
    }
  }

  if (error) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm text-red-600">{error}</p>
      </section>
    );
  }

  if (stats === null) {
    return (
      <section className="flex flex-1 items-center justify-center px-6 text-sm text-slate-500">
        Загрузка…
      </section>
    );
  }

  return (
    <section className="flex flex-1 flex-col gap-6 pt-10">
      <h1 className="px-4 text-lg font-medium text-ink">История</h1>

      <div className="flex justify-center gap-2 px-4">
        <TabButton label="Сделки" active={tab === "trades"} onClick={() => setTab("trades")} />
        <TabButton label="Статистика" active={tab === "stats"} onClick={() => setTab("stats")} />
      </div>

      {tab === "trades" ? (
        <>
          <InsightPanel stats={stats} />

          {trades.length === 0 ? (
            <p className="px-6 text-center text-sm text-slate-500">Закрытых сделок пока нет.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {trades.map((trade) => (
                <TradeRow key={trade.id} trade={trade} />
              ))}
            </div>
          )}

          {trades.length < total && (
            <button
              type="button"
              onClick={loadMore}
              disabled={isLoadingMore}
              className="mx-4 rounded-xl border border-line py-2 text-sm text-slate-600 disabled:opacity-50"
            >
              {isLoadingMore ? "Загружаю…" : "Показать ещё"}
            </button>
          )}
        </>
      ) : trades.length === 0 ? (
        <p className="px-6 text-center text-sm text-slate-500">Закрытых сделок пока нет.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {trades.map((trade) => (
            <TrackingRow key={trade.id} trade={trade} />
          ))}
        </div>
      )}
    </section>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white"
          : "rounded-full border border-line px-4 py-1.5 text-sm text-slate-500"
      }
    >
      {label}
    </button>
  );
}

import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../../api/http";
import { getJournalTrades, getOverview, type TradesFilter } from "../api";
import { TradeCard } from "../components/TradeCard";
import type { JournalOverview, JournalTradeCard } from "../types";

const PAGE_SIZE = 50;

/**
 * Лента «Разбора»: закрытые сделки с чипами-фильтрами. По умолчанию — «Неразобранные»:
 * это рабочая очередь журнала, новые закрытые сделки попадают в неё сами.
 */
export function Review() {
  const [overview, setOverview] = useState<JournalOverview | null>(null);
  const [filter, setFilter] = useState<TradesFilter>("unsorted");
  const [trades, setTrades] = useState<JournalTradeCard[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  useEffect(() => {
    refreshOverview();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    getJournalTrades(filter, PAGE_SIZE, 0)
      .then((page) => {
        if (cancelled) return;
        setTrades(page.trades);
        setTotal(page.total);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Не удалось загрузить сделки");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter]);

  async function refreshOverview() {
    try {
      setOverview(await getOverview());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить журнал");
    }
  }

  async function loadMore() {
    setIsLoadingMore(true);
    try {
      const page = await getJournalTrades(filter, PAGE_SIZE, trades.length);
      setTrades((current) => [...current, ...page.trades]);
      setTotal(page.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить сделки");
    } finally {
      setIsLoadingMore(false);
    }
  }

  const categoryNames = useMemo(() => {
    const map = new Map<number, string>();
    for (const category of overview?.categories ?? []) map.set(category.id, category.name);
    return map;
  }, [overview]);

  /** Группировка ленты по локальной дате закрытия — «разбивка по датам». */
  const groups = useMemo(() => {
    const result: { date: string; trades: JournalTradeCard[] }[] = [];
    for (const trade of trades) {
      const date = trade.closedAt
        ? new Date(trade.closedAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })
        : "Без даты";
      const last = result[result.length - 1];
      if (last && last.date === date) {
        last.trades.push(trade);
      } else {
        result.push({ date, trades: [trade] });
      }
    }
    return result;
  }, [trades]);

  if (error) {
    return (
      <section className="flex flex-1 items-center justify-center px-6">
        <p className="text-sm text-negative">{error}</p>
      </section>
    );
  }

  return (
    <section className="flex flex-1 flex-col gap-4 pt-10 pb-4">
      <h1 className="px-4 text-lg font-medium text-ink">Разбор сделок</h1>

      {/* Чипы-фильтры. Горизонтальный скролл: категорий может быть много. */}
      <div className="flex gap-1.5 overflow-x-auto px-4 pb-1 [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <FilterChip
          label={`Неразобранные${overview ? ` · ${overview.unsortedCount}` : ""}`}
          active={filter === "unsorted"}
          onClick={() => setFilter("unsorted")}
        />
        <FilterChip label="Все" active={filter === "all"} onClick={() => setFilter("all")} />
        {(overview?.categories ?? []).map((category) => (
          <FilterChip
            key={category.id}
            label={`${category.name} · ${category.tradesCount}`}
            active={filter === category.id}
            onClick={() => setFilter(category.id)}
          />
        ))}
      </div>

      {isLoading ? (
        <p className="px-6 text-center text-sm text-muted">Загрузка…</p>
      ) : trades.length === 0 ? (
        <EmptyState filter={filter} onShowAll={() => setFilter("all")} />
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <div key={group.date} className="flex flex-col gap-3">
              <p className="px-4 text-xs font-medium uppercase tracking-wide text-muted">{group.date}</p>
              {group.trades.map((trade) => (
                <TradeCard
                  key={trade.id}
                  trade={trade}
                  // Чип категории имеет смысл только в смешанной ленте «Все»: в фильтрах
                  // «Неразобранные» и по категории он одинаков у каждой карточки — шум.
                  showCategory={filter === "all"}
                  categoryName={trade.categoryId !== null ? (categoryNames.get(trade.categoryId) ?? null) : null}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {!isLoading && trades.length < total && (
        <button
          type="button"
          onClick={loadMore}
          disabled={isLoadingMore}
          className="mx-4 rounded-xl border border-line py-2 text-sm text-muted disabled:opacity-50"
        >
          {isLoadingMore ? "Загружаю…" : "Показать ещё"}
        </button>
      )}
    </section>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const tone = active ? "bg-accent text-white font-medium" : "border border-line bg-card text-muted";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm ${tone}`}
    >
      {label}
    </button>
  );
}

function EmptyState({ filter, onShowAll }: { filter: TradesFilter; onShowAll: () => void }) {
  if (filter === "unsorted") {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
        <p className="text-sm text-ink">Все сделки разобраны</p>
        <p className="text-xs text-muted">Новые закрытые сделки появятся здесь сами.</p>
        <button type="button" onClick={onShowAll} className="text-sm font-medium text-accent">
          Показать все сделки
        </button>
      </div>
    );
  }
  return <p className="px-6 py-8 text-center text-sm text-muted">Сделок пока нет.</p>;
}

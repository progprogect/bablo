import { useEffect, useState } from "react";
import { ApiError, getStats, getTradeHistory } from "../api/client";
import { formatSignedR } from "../lib/format";
import type { MonthlyStat, StatsResponse, Trade } from "../api/types";
import { EquityHistorySheet } from "./history/EquityHistorySheet";
import { InsightPanel } from "./history/InsightPanel";
import { MonthDetailSheet } from "./history/MonthDetailSheet";
import { MonthlyStatCard } from "./history/MonthlyStatCard";
import { ChimeSoundPicker } from "./history/ChimeSoundPicker";
import { NotificationsSection } from "./history/NotificationsSection";
import { TradeRow } from "./history/TradeRow";
import { WithdrawalsCard } from "./history/WithdrawalsCard";

const PAGE_SIZE = 20;

type Tab = "trades" | "stats" | "withdrawals" | "notifications";

export function History() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [total, setTotal] = useState(0);
  /** Сводка «+R / −R» по всей выборке часа — приходит вместе со страницей при фильтре. */
  const [filterR, setFilterR] = useState<{ positive: number; negative: number } | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [tab, setTab] = useState<Tab>("trades");
  const [showEquityChart, setShowEquityChart] = useState(false);
  const [monthDetail, setMonthDetail] = useState<MonthlyStat | null>(null);
  /**
   * Фильтр по часу открытия: клик по часу в подсказке (просьба от 23.09.2026). Живёт
   * обычным стейтом — повторный клик и перезагрузка страницы сбрасывают его, как и
   * просил пользователь; в URL и localStorage намеренно не сохраняется.
   */
  const [hourFilter, setHourFilter] = useState<number | null>(null);

  useEffect(() => {
    getStats()
      .then(setStats)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить историю"));
  }, []);

  // Список перезагружается с сервера при смене фильтра: фильтровать уже загруженную
  // страницу нельзя — в ней лежат только первые 20 сделок, и час из подсказки показал бы
  // меньше сделок, чем в ней написано.
  useEffect(() => {
    let cancelled = false;
    getTradeHistory(PAGE_SIZE, 0, hourFilter)
      .then((history) => {
        if (cancelled) return;
        setTrades(history.trades);
        setTotal(history.total);
        setFilterR(
          history.sumPositiveR !== undefined && history.sumNegativeR !== undefined
            ? { positive: history.sumPositiveR, negative: history.sumNegativeR }
            : null,
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Не удалось загрузить историю");
      });
    return () => {
      cancelled = true;
    };
  }, [hourFilter]);

  async function loadMore() {
    setIsLoadingMore(true);
    try {
      const next = await getTradeHistory(PAGE_SIZE, trades.length, hourFilter);
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

      {/* Четыре таба в 375px: при px-4/gap-2 ряду нужно 379px и он не влезает (замерено
          23.09.2026). Поджаты отступы, а не названия — запас стал 30px. */}
      <div className="flex justify-center gap-1.5 px-2">
        <TabButton label="Сделки" active={tab === "trades"} onClick={() => setTab("trades")} />
        <TabButton label="Статистика" active={tab === "stats"} onClick={() => setTab("stats")} />
        <TabButton
          label="Выводы"
          active={tab === "withdrawals"}
          onClick={() => setTab("withdrawals")}
        />
        {/* Уведомления — редкая настройка «включил и забыл», поэтому занимают не слово, а
            иконку (просьба от 23.09.2026): освободившееся место ушло вкладке «Выводы». */}
        <TabButton
          label="Уведомления"
          iconOnly
          active={tab === "notifications"}
          onClick={() => setTab("notifications")}
        />
      </div>

      {tab === "notifications" && (
        <div className="mx-4 flex flex-col gap-3">
          <NotificationsSection />
          <ChimeSoundPicker />
        </div>
      )}

      {tab === "withdrawals" && (
        <div className="mx-4 flex flex-col gap-3">
          <WithdrawalsCard />
        </div>
      )}

      {tab === "trades" && (
        <>
          <InsightPanel
            insights={stats.insights}
            tzOffsetMinutes={stats.tzOffsetMinutes}
            blockedHours={stats.blockedHours ?? []}
            selectedHour={hourFilter}
            onSelectHour={(hour) => setHourFilter((current) => (current === hour ? null : hour))}
          />

          {/* Список уезжает под подсказку, поэтому без этой строки непонятно, почему сделок
              вдруг мало. Она же — кнопка сброса, кроме повторного клика по часу. */}
          {hourFilter !== null && (
            <div className="mx-4 flex items-center justify-between gap-2 rounded-xl border border-accent/30 bg-accent/[0.07] px-3 py-2">
              <span className="text-xs text-slate-600">
                Открытые в {hourFilter}ч · {total}
                {/* Сводка по R — рядом с числом сделок, чтобы час читался одной строкой:
                    сколько входов и чем они в сумме закончились. Прячем, когда R нет
                    вовсе (обе суммы нулевые), — «+0R / 0R» ничего не сообщает. */}
                {filterR && (filterR.positive !== 0 || filterR.negative !== 0) && (
                  <>
                    <span className="text-slate-400"> · </span>
                    <span className="font-medium text-emerald-600">
                      {formatSignedR(filterR.positive)}
                    </span>
                    <span className="text-slate-400"> / </span>
                    <span className="font-medium text-red-600">
                      {formatSignedR(filterR.negative)}
                    </span>
                  </>
                )}
              </span>
              <button
                type="button"
                onClick={() => setHourFilter(null)}
                className="text-xs font-medium text-accent underline-offset-2 hover:underline"
              >
                показать все
              </button>
            </div>
          )}

          {trades.length === 0 ? (
            <p className="px-6 text-center text-sm text-slate-500">
              {hourFilter !== null ? `В ${hourFilter}ч сделок не было.` : "Закрытых сделок пока нет."}
            </p>
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
      )}

      {tab === "stats" && (
        <div className="mx-4 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setShowEquityChart(true)}
            className="rounded-xl border border-line bg-card py-2.5 text-sm font-medium text-accent shadow-sm"
          >
            График роста депозита
          </button>

          {stats.monthly.length === 0 ? (
            <p className="px-2 text-center text-sm text-slate-500">Пока нет ни одного закрытого месяца.</p>
          ) : (
            stats.monthly.map((stat) => (
              // Карточка сама не меняется — только становится кликабельной: нажатие
              // открывает детализацию месяца (все сделки + диаграмма плюс/минус).
              <button
                key={`${stat.year}-${stat.month}`}
                type="button"
                onClick={() => setMonthDetail(stat)}
                className="w-full text-left"
              >
                <MonthlyStatCard stat={stat} />
              </button>
            ))
          )}
        </div>
      )}

      {showEquityChart && <EquityHistorySheet onClose={() => setShowEquityChart(false)} />}

      {monthDetail && <MonthDetailSheet stat={monthDetail} onClose={() => setMonthDetail(null)} />}
    </section>
  );
}

/**
 * Колокольчик вкладки «Уведомления»: свой SVG в стиле остальных значков приложения
 * (галочка прибыльного часа, замок в подсказке), а не эмодзи — эмодзи выглядит инородно
 * и рисуется по-разному на разных системах. `currentColor` — чтобы активное и неактивное
 * состояние окрашивались тем же правилом, что и текстовые табы.
 */
function BellIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" aria-hidden="true">
      <path
        d="M5.5 8.2a4.5 4.5 0 0 1 9 0c0 2.5.5 3.9 1.2 4.8.3.4 0 1-.5 1H4.8c-.5 0-.8-.6-.5-1 .7-.9 1.2-2.3 1.2-4.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8.3 16a1.8 1.8 0 0 0 3.4 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Таб экрана «История». `iconOnly` — узкий таб только со значком: label остаётся, но уходит
 * в aria-label, чтобы кнопка оставалась понятной без зрения.
 */
function TabButton({
  label,
  active,
  onClick,
  iconOnly = false,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  iconOnly?: boolean;
}) {
  const tone = active
    ? "bg-accent text-white font-medium"
    : "border border-line text-slate-500";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      className={`flex items-center justify-center rounded-full py-1.5 text-sm ${tone} ${
        iconOnly ? "px-2.5" : "px-3.5"
      }`}
    >
      {iconOnly ? <BellIcon /> : label}
    </button>
  );
}

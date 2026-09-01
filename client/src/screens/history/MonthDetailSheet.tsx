import { useEffect, useState } from "react";
import { ApiError, getMonthTrades } from "../../api/client";
import type { MonthExchangeSummary, MonthlyStat, Trade } from "../../api/types";
import { formatSignedUsd } from "../../lib/format";
import { MONTH_LABELS } from "./MonthlyStatCard";
import { TradeRow } from "./TradeRow";

/** Реализованный результат в USDT — та же формула, что в карточке сделки (TradeRow). */
function realizedPnlUsd(trade: Trade): number | null {
  if (trade.resultR === null || trade.riskUsd === null) return null;
  return Number(trade.resultR) * Number(trade.riskUsd);
}

function pluralTrades(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return "сделок";
  if (mod10 === 1) return "сделка";
  if (mod10 >= 2 && mod10 <= 4) return "сделки";
  return "сделок";
}

/** Строка диаграммы: подпись с числом сделок, сумма и полоса, ширина — доля от большей из сумм. */
function BarRow({
  label,
  count,
  sumUsd,
  maxAbsUsd,
  tone,
}: {
  label: string;
  count: number;
  sumUsd: number;
  maxAbsUsd: number;
  tone: "profit" | "loss";
}) {
  const widthPct = maxAbsUsd > 0 ? Math.max((Math.abs(sumUsd) / maxAbsUsd) * 100, 2) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-slate-500">
          {label} · {count} {pluralTrades(count)}
        </span>
        <span className={`font-medium ${tone === "profit" ? "text-emerald-600" : "text-red-600"}`}>
          {formatSignedUsd(sumUsd)}
        </span>
      </div>
      <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-line/60">
        <div
          className={`h-full rounded-full ${tone === "profit" ? "bg-emerald-500" : "bg-red-500"}`}
          style={{ width: `${widthPct}%` }}
        />
      </div>
    </div>
  );
}

function formatEquity(value: number): string {
  return `${value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

/**
 * Полный результат месяца по журналу биржи: реализованный PnL всех позиций (включая
 * открытые мимо приложения) + комиссии + funding + прочие начисления, БЕЗ переводов.
 * Тождественно равен «баланс конца − баланс начала − пополнения/выводы» — это и есть
 * граунд-трус месяца. Просьба от 30.08.2026: показывать именно одно это число, без
 * россыпи диагностических строк (комиссии/funding/сверки отдельными строками убраны —
 * сервер их по-прежнему отдаёт, см. GET /api/trades/month).
 */
function exchangeMonthPnl(exchange: MonthExchangeSummary): number {
  return exchange.realizedPnlUsd + exchange.commissionUsd + exchange.fundingUsd + exchange.otherUsd;
}

/**
 * Детализация месяца: открывается нажатием на карточку месяца в «Статистике».
 * Сверху — диаграмма «сумма плюса против суммы минуса» по сделкам ПРИЛОЖЕНИЯ, затем
 * блок «Депозит»: баланс на точных границах месяца (журнал биржи; запасной путь —
 * дневные снимки с «≈») и одно число «PnL за месяц (BingX)» — полный факт биржи.
 * Ниже — все сделки месяца, разложенные на плюсовые и минусовые.
 */
export function MonthDetailSheet({ stat, onClose }: { stat: MonthlyStat; onClose: () => void }) {
  const { year, month } = stat;
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [exchange, setExchange] = useState<MonthExchangeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === month;

  useEffect(() => {
    setTrades(null);
    setExchange(null);
    getMonthTrades(year, month)
      .then((response) => {
        setTrades(response.trades);
        setExchange(response.exchange);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить сделки месяца"));
  }, [year, month]);

  const plus: Trade[] = [];
  const minus: Trade[] = [];
  const flat: Trade[] = [];
  let plusSum = 0;
  let minusSum = 0;
  for (const trade of trades ?? []) {
    const pnl = realizedPnlUsd(trade);
    if (pnl !== null && pnl > 0) {
      plus.push(trade);
      plusSum += pnl;
    } else if (pnl !== null && pnl < 0) {
      minus.push(trade);
      minusSum += pnl;
    } else {
      flat.push(trade);
    }
  }
  const netSum = plusSum + minusSum;
  const maxAbsUsd = Math.max(plusSum, Math.abs(minusSum));
  const netColorClass =
    netSum > 0 ? "text-emerald-600" : netSum < 0 ? "text-red-600" : "text-slate-600";

  // Границы месяца из журнала биржи — точные значения на те же даты, что у статистики
  // (полночь 1-го числа МСК). Null — журнал недоступен/неполный, запасной путь — снимки.
  const ledgerStart = exchange?.balanceStartUsd ?? null;
  const ledgerEnd = exchange?.balanceEndUsd ?? null;
  const hasLedgerBalances = ledgerStart !== null && ledgerEnd !== null;

  const monthPnl = exchange ? exchangeMonthPnl(exchange) : null;
  const monthPnlColorClass =
    monthPnl === null
      ? ""
      : monthPnl > 0
        ? "text-emerald-600"
        : monthPnl < 0
          ? "text-red-600"
          : "text-slate-600";

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-surface">
      <div
        className="flex items-center justify-between border-b border-line px-4 pb-3"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 16px)" }}
      >
        <h2 className="text-base font-medium text-ink">
          {MONTH_LABELS[month - 1]} {year}
        </h2>
        <button type="button" onClick={onClose} className="text-sm text-slate-500">
          Закрыть
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-4">
        {error ? (
          <p className="px-4 text-center text-sm text-red-600">{error}</p>
        ) : trades === null ? (
          <p className="px-4 text-center text-sm text-slate-500">Загрузка…</p>
        ) : trades.length === 0 ? (
          <p className="px-4 text-center text-sm text-slate-500">В этом месяце сделок нет.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="mx-4 flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
              <BarRow label="Плюс" count={plus.length} sumUsd={plusSum} maxAbsUsd={maxAbsUsd} tone="profit" />
              <BarRow label="Минус" count={minus.length} sumUsd={minusSum} maxAbsUsd={maxAbsUsd} tone="loss" />
              <div className="flex items-baseline justify-between border-t border-line pt-2.5">
                <span className="text-xs text-slate-500">Итог</span>
                <span className={`text-base font-semibold ${netColorClass}`}>
                  {formatSignedUsd(netSum)}
                </span>
              </div>
            </div>

            {(stat.startEquity !== null || stat.endEquity !== null || hasLedgerBalances) && (
              <div className="mx-4 flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 shadow-sm">
                <h3 className="text-sm font-medium text-ink">Депозит</h3>
                {hasLedgerBalances ? (
                  <>
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="text-xs text-slate-500">На начало месяца</span>
                      <span className="font-medium tabular-nums text-ink">
                        {formatEquity(ledgerStart!)}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="text-xs text-slate-500">
                        {isCurrentMonth ? "Сейчас" : "На конец месяца"}
                      </span>
                      <span className="font-medium tabular-nums text-ink">
                        {formatEquity(ledgerEnd!)}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    {stat.startEquity !== null && (
                      <div className="flex items-baseline justify-between text-sm">
                        <span className="text-xs text-slate-500">На начало месяца</span>
                        <span className="font-medium tabular-nums text-ink">
                          {stat.startEquityExact ? "" : "≈ "}
                          {formatEquity(stat.startEquity)}
                        </span>
                      </div>
                    )}
                    {stat.endEquity !== null && (
                      <div className="flex items-baseline justify-between text-sm">
                        <span className="text-xs text-slate-500">
                          {isCurrentMonth ? "Сейчас" : "На конец месяца"}
                        </span>
                        <span className="font-medium tabular-nums text-ink">
                          {stat.endEquityExact ? "" : "≈ "}
                          {formatEquity(stat.endEquity)}
                        </span>
                      </div>
                    )}
                    {(stat.startEquity !== null && !stat.startEquityExact) ||
                    (stat.endEquity !== null && !stat.endEquityExact) ? (
                      <p className="text-xs text-slate-400">
                        «≈» — точных данных биржи на эту дату уже нет, значение восстановлено
                        от ближайшего дневного снимка.
                      </p>
                    ) : null}
                  </>
                )}

                {monthPnl !== null && (
                  <div className="flex items-baseline justify-between border-t border-line pt-2.5">
                    <span className="text-xs text-slate-500">PnL за месяц (BingX)</span>
                    <span className={`text-base font-semibold tabular-nums ${monthPnlColorClass}`}>
                      {formatSignedUsd(monthPnl)}
                    </span>
                  </div>
                )}
                {monthPnl !== null && (
                  <p className="text-xs text-slate-400">
                    Точный результат месяца по журналу биржи: все позиции (включая открытые
                    мимо приложения), с комиссиями и funding; пополнения/выводы не входят.
                    «Итог» выше — только сделки приложения, по ценам без комиссий.
                  </p>
                )}
              </div>
            )}

            {plus.length > 0 && (
              <TradeGroup title={`Плюсовые (${plus.length})`} trades={plus} />
            )}
            {minus.length > 0 && (
              <TradeGroup title={`Минусовые (${minus.length})`} trades={minus} />
            )}
            {flat.length > 0 && <TradeGroup title={`В нуле (${flat.length})`} trades={flat} />}
          </div>
        )}
      </div>
    </div>
  );
}

function TradeGroup({ title, trades }: { title: string; trades: Trade[] }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="px-4 text-sm font-medium text-ink">{title}</h3>
      {trades.map((trade) => (
        <TradeRow key={trade.id} trade={trade} />
      ))}
    </div>
  );
}

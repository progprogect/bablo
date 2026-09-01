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

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Сырые записи биржи по типам — чтобы «не сходится на X» можно было объяснить данными:
 * видно каждый incomeType с суммой и числом записей и окно, за которое биржа реально
 * отдала историю (если оно уже месяца — часть начислений просто не пришла из API).
 */
function ExchangeRecordsDetails({ exchange }: { exchange: MonthExchangeSummary }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-t border-line pt-2">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="text-xs font-medium text-accent underline-offset-2 hover:underline"
      >
        {open ? "Скрыть записи биржи" : `Показать записи биржи (${exchange.recordCount})`}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1">
          {exchange.byType.map((entry) => (
            <div key={entry.type} className="flex items-baseline justify-between text-xs">
              <span className="text-slate-500">
                {entry.type} · {entry.count}
              </span>
              <span className="tabular-nums text-slate-600">{formatSignedUsd(entry.sumUsd)}</span>
            </div>
          ))}
          {exchange.firstRecordAt && exchange.lastRecordAt && (
            <p className="mt-1 text-xs text-slate-400">
              История биржи с {formatShortDate(exchange.firstRecordAt)} по{" "}
              {formatShortDate(exchange.lastRecordAt)}. Если период уже месяца — BingX отдал
              не все записи, и суммы выше неполные.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function DepositRow({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-baseline justify-between border-t border-line pt-2 text-sm">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="font-medium tabular-nums text-slate-600">{formatSignedUsd(value)}</span>
    </div>
  );
}

/**
 * Детализация месяца: открывается нажатием на карточку месяца в «Статистике».
 * Сверху — диаграмма «сумма плюса против суммы минуса» с итогом (видно, чего по деньгам
 * вышло больше) и фактический депозит на начало/конец месяца, ниже — ВСЕ сделки месяца
 * (включая внешние/ручные закрытия без классификации — попадание в плюс/минус решает
 * только знак результата), разложенные на плюсовые и минусовые.
 * Суммы в USDT считаются так же, как в карточках сделок: resultR × риск сделки.
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

  /**
   * Сверка с фактом биржи (exchange = записи BingX user/income за месяц): комиссии,
   * funding и переводы — не наша оценка, а реальные начисления. Контрольная строка
   * «Расхождение» = конец − начало − (PnL биржи + комиссии + funding + прочее + переводы):
   * ≈ 0 — всё учтено; заметная величина — сигнал (например, незакрытая позиция на границе
   * месяца, чей нереализованный PnL сидит в снимке).
   */
  const mismatchUsd =
    exchange && stat.startEquity !== null && stat.endEquity !== null
      ? stat.endEquity -
        stat.startEquity -
        exchange.realizedPnlUsd -
        exchange.commissionUsd -
        exchange.fundingUsd -
        exchange.otherUsd -
        exchange.transfersUsd
      : null;
  // Итог сделок приложения против PnL биржи: расходятся — какие-то сделки не учтены.
  const pnlGapUsd = exchange ? exchange.realizedPnlUsd - netSum : null;
  // Число записей REALIZED_PNL = число закрытий на бирже. Сравнение с числом сделок в
  // приложении отвечает на «все ли сделки учтены» фактом, а не догадкой.
  const closeRecordCount = exchange
    ? exchange.byType
        .filter((entry) => entry.type.toUpperCase().includes("PNL"))
        .reduce((sum, entry) => sum + entry.count, 0)
    : null;
  // Оценка на случай, когда факта с биржи нет (месяц старше глубины хранения BingX).
  const estimatedOtherUsd =
    !exchange && stat.startEquity !== null && stat.endEquity !== null
      ? stat.endEquity - stat.startEquity - netSum - stat.adjustmentsUsd
      : null;
  const showEstimatedOther = estimatedOtherUsd !== null && Math.abs(estimatedOtherUsd) >= 0.5;

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

            {(stat.startEquity !== null || stat.endEquity !== null) && (
              <div className="mx-4 flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 shadow-sm">
                <h3 className="text-sm font-medium text-ink">Депозит</h3>
                {stat.startEquity !== null && (
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-xs text-slate-500">На начало месяца</span>
                    <span className="font-medium tabular-nums text-ink">
                      {formatEquity(stat.startEquity)}
                    </span>
                  </div>
                )}
                {stat.endEquity !== null && (
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-xs text-slate-500">{isCurrentMonth ? "Сейчас" : "На конец месяца"}</span>
                    <span className="font-medium tabular-nums text-ink">
                      {formatEquity(stat.endEquity)}
                    </span>
                  </div>
                )}
                {exchange ? (
                  <>
                    <div className="flex items-baseline justify-between border-t border-line pt-2 text-sm">
                      <span className="text-xs text-slate-500">PnL по данным биржи</span>
                      <span className="font-medium tabular-nums text-slate-600">
                        {formatSignedUsd(exchange.realizedPnlUsd)}
                      </span>
                    </div>
                    <DepositRow label="Комиссии (BingX)" value={exchange.commissionUsd} />
                    <DepositRow label="Funding (BingX)" value={exchange.fundingUsd} />
                    {Math.abs(exchange.otherUsd) >= 0.01 && (
                      <DepositRow label="Прочие начисления (BingX)" value={exchange.otherUsd} />
                    )}
                    {exchange.transfersUsd !== 0 && (
                      <DepositRow label="Пополнения/выводы (BingX)" value={exchange.transfersUsd} />
                    )}
                    {pnlGapUsd !== null && Math.abs(pnlGapUsd) >= 0.5 && (
                      <p className="text-xs text-amber-700">
                        Итог сделок в приложении ({formatSignedUsd(netSum)}) расходится с PnL
                        биржи на {formatSignedUsd(pnlGapUsd)}.{" "}
                        {closeRecordCount !== null
                          ? `Закрытий по данным биржи: ${closeRecordCount}, сделок в приложении: ${trades.length}${
                              closeRecordCount === trades.length
                                ? " — все сделки на месте, расходятся суммы (комиссии внутри цены закрытия, ручные правки R)."
                                : " — часть сделок не учтена в приложении."
                            }`
                          : "Возможно, часть сделок не учтена в приложении."}
                      </p>
                    )}
                    {mismatchUsd !== null &&
                      (Math.abs(mismatchUsd) >= 0.5 ? (
                        <div className="flex items-baseline justify-between border-t border-line pt-2 text-sm">
                          <span className="text-xs text-amber-700">Не сходится на</span>
                          <span className="font-medium tabular-nums text-amber-700">
                            {formatSignedUsd(mismatchUsd)}
                          </span>
                        </div>
                      ) : (
                        <p className="border-t border-line pt-2 text-xs text-emerald-600">
                          Сходится с фактом биржи: начало + PnL + комиссии + funding + переводы
                          = конец месяца.
                        </p>
                      ))}
                    <p className="text-xs text-slate-400">
                      Комиссии, funding и переводы — фактические записи BingX за месяц. Итог
                      сделок — чистый результат по цене, поэтому он не включает эти списания.
                    </p>
                    <ExchangeRecordsDetails exchange={exchange} />
                  </>
                ) : (
                  <>
                    {stat.adjustmentsUsd !== 0 && (
                      <DepositRow
                        label="Пополнения/выводы за месяц (админка)"
                        value={stat.adjustmentsUsd}
                      />
                    )}
                    {showEstimatedOther && (
                      <DepositRow
                        label="Комиссии, funding и прочее (оценка)"
                        value={estimatedOtherUsd}
                      />
                    )}
                    {(stat.adjustmentsUsd !== 0 || showEstimatedOther) && (
                      <p className="text-xs text-slate-400">
                        Факт начислений BingX за этот месяц недоступен (история биржи
                        ограничена по глубине) — показана оценка: конец − начало − итог
                        сделок − записанные пополнения.
                      </p>
                    )}
                  </>
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

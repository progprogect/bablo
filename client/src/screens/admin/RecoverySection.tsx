import { useState } from "react";
import { ApiError, importBingxHistory } from "../../api/client";
import type { BingxImportResult, ImportHourStat, ImportedTradeView } from "../../api/types";

/**
 * Восстановление данных после потери базы (01.11.2026). База осталась у заблокированного
 * хостинга Railway, приложение переехало на пустую — а биржа свои ордера помнит.
 *
 * Два шага, и порядок не случайный (просьба пользователя): сначала СТАТИСТИКА ПО ЧАСАМ —
 * ради неё всё и затевалось, она подсказывает, когда торговать; и только потом запись
 * самих сделок в базу. Один запрос к бирже обслуживает оба шага, но пишет только второй.
 */

/** Доля тейков, с которой час считается прибыльным, — как в живой гистограмме «Сделки». */
const STRONG_SHARE = 0.5;
/** Минимальная ширина полосы, чтобы час с одним тейком не выглядел пустым. */
const MIN_BAR_PCT = 4;

function formatDate(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function outcomeLabel(trade: ImportedTradeView): string {
  if (trade.closeReason === "tp") return "Тейк";
  if (trade.closeReason === "sl") return "Стоп";
  return "Вручную";
}

/**
 * Строка часа: доля тейков полосой относительно 100%, засечка на половине — граница
 * прибыльного часа. Вид повторяет гистограмму на экране «Сделки», чтобы восстановленные
 * часы читались тем же взглядом; интерактивности здесь нет — это предпросмотр.
 */
function HourBar({ stat }: { stat: ImportHourStat }) {
  const share = stat.total > 0 ? stat.tpCount / stat.total : 0;
  const pct = Math.round(share * 100);
  const isStrong = share >= STRONG_SHARE;
  return (
    <li className="flex items-center gap-1.5 py-0.5">
      <span className="w-6 shrink-0 text-[11px] tabular-nums text-slate-600">{stat.hour}ч</span>
      <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-line/70">
        <span className="absolute inset-y-0 left-1/2 w-px bg-slate-900/10" />
        <span
          className={`absolute inset-y-0 left-0 rounded-full ${
            isStrong
              ? "bg-gradient-to-r from-emerald-400 to-emerald-500"
              : "bg-gradient-to-r from-slate-300 to-slate-400"
          }`}
          style={{ width: `${Math.max(pct, MIN_BAR_PCT)}%` }}
        />
      </span>
      <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-slate-400">
        {stat.tpCount}/{stat.total}
      </span>
      <span
        className={`w-9 shrink-0 text-right text-[11px] tabular-nums ${
          isStrong ? "text-emerald-600" : "text-slate-400"
        }`}
      >
        {pct}%
      </span>
    </li>
  );
}

function TradeRow({ trade }: { trade: ImportedTradeView }) {
  const r = trade.resultR;
  const rColor =
    r === null ? "text-slate-400" : r > 0 ? "text-emerald-600" : r < 0 ? "text-red-600" : "text-slate-500";
  return (
    <li className={`flex items-center justify-between gap-2 py-1 ${trade.duplicate ? "opacity-40" : ""}`}>
      <span className="flex min-w-0 flex-col">
        <span className="text-xs text-ink">
          {trade.symbol.replace(/-USDT$/, "")} · {trade.side === "long" ? "лонг" : "шорт"} ·{" "}
          {outcomeLabel(trade)}
        </span>
        <span className="text-[10px] text-slate-400">
          {formatDate(trade.closedAt)}
          {trade.duplicate ? " · уже в базе" : ""}
        </span>
      </span>
      <span className="flex shrink-0 items-baseline gap-2">
        <span className={`text-xs font-medium ${rColor}`}>
          {r === null ? "R —" : `${r > 0 ? "+" : ""}${r.toFixed(1)}R`}
        </span>
        <span className="text-[10px] tabular-nums text-slate-400">
          {trade.realizedPnlUsd > 0 ? "+" : ""}
          {trade.realizedPnlUsd.toFixed(2)}
        </span>
      </span>
    </li>
  );
}

export function RecoverySection() {
  const [days, setDays] = useState(30);
  const [result, setResult] = useState<BingxImportResult | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [showTrades, setShowTrades] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await importBingxHistory(days, dryRun);
      setResult(response);
      if (!dryRun) {
        setNotice(
          response.imported > 0
            ? `Записано сделок: ${response.imported}`
            : "Новых сделок не нашлось — всё уже в базе",
        );
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось получить историю с биржи");
    } finally {
      setIsBusy(false);
    }
  }

  const fresh = result?.trades.filter((trade) => !trade.duplicate) ?? [];
  const hourly = result?.hourly ?? [];
  const hourTotals = hourly.reduce(
    (acc, stat) => ({ total: acc.total + stat.total, tp: acc.tp + stat.tpCount }),
    { total: 0, tp: 0 },
  );

  return (
    <section className="flex flex-col gap-3 pt-6">
      <div>
        <h2 className="text-sm font-medium text-ink">Восстановление данных</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Собирает закрытые сделки из журнала ордеров BingX. Загрузка ничего не пишет —
          сначала смотрим статистику по часам, запись истории отдельной кнопкой.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-xs text-slate-500">Глубина, дней</label>
        <input
          type="number"
          value={days}
          min={1}
          max={180}
          onChange={(event) => setDays(Number(event.target.value))}
          className="w-20 rounded-md border border-line bg-transparent px-2 py-1 text-center text-sm text-ink outline-none focus:border-accent"
        />
        <button
          type="button"
          disabled={isBusy}
          onClick={() => run(true)}
          className="flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink disabled:opacity-60"
        >
          {isBusy ? "Загружаю…" : "Загрузить с биржи"}
        </button>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
      {notice && <p className="text-xs text-emerald-600">{notice}</p>}

      {result && (
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-card p-3">
          <p className="text-[11px] text-slate-500">
            Ордеров получено: {result.ordersFetched} · собрано сделок: {result.trades.length} ·
            новых для базы: {fresh.length}
          </p>

          {/* Шаг 1 — то, ради чего всё затевалось. */}
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-ink">Шаг 1. Статистика по часам</p>
            {hourly.length > 0 ? (
              <>
                <ul className="flex flex-col">
                  {hourly.map((stat) => (
                    <HourBar key={stat.hour} stat={stat} />
                  ))}
                </ul>
                <p className="text-[11px] text-slate-400">
                  Всего {hourTotals.total} сделок, из них тейком {hourTotals.tp}. Зелёным —
                  часы, где тейков не меньше половины. Часы в таймзоне риск-плана.
                </p>
              </>
            ) : (
              <p className="text-xs text-slate-500">
                Биржа не отдала закрытых сделок с результатом за этот период.
              </p>
            )}
          </div>

          {/* Шаг 2 — запись истории; список по умолчанию свёрнут, чтобы не заслонять часы. */}
          <div className="flex flex-col gap-2 border-t border-line pt-2">
            <p className="text-xs font-medium text-ink">Шаг 2. История сделок</p>
            {result.trades.length > 0 && (
              <button
                type="button"
                onClick={() => setShowTrades((current) => !current)}
                className="self-start text-[11px] text-accent"
              >
                {showTrades ? "Скрыть список" : `Показать список (${result.trades.length})`}
              </button>
            )}
            {showTrades && (
              <ul className="flex max-h-72 flex-col overflow-y-auto">
                {result.trades.map((trade) => (
                  <TradeRow key={trade.orderIds.entry.join("-")} trade={trade} />
                ))}
              </ul>
            )}
            <button
              type="button"
              disabled={isBusy || fresh.length === 0}
              onClick={() => run(false)}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Записать в базу{fresh.length > 0 ? ` (${fresh.length})` : ""}
            </button>
          </div>

          {result.skipped.length > 0 && (
            <p className="text-[11px] text-slate-400">
              Пропущено: {result.skipped.map((skip) => skip.reason).join("; ")}
            </p>
          )}
          {result.errors.length > 0 && (
            <p className="text-[11px] text-amber-700">
              Биржа ответила ошибкой по части запросов:{" "}
              {result.errors.map((item) => `${item.symbol} — ${item.error}`).join("; ")}
            </p>
          )}
          <p className="text-[11px] text-slate-400">
            Что не восстанавливается: пресет R/R, с которым входили, ручные пометки исхода и
            привязка выводов к уровням — биржа этого не помнит. R считается по стоп-ордеру;
            сделка без стопа в истории идёт без R — она попадёт в список сделок, но не в
            статистику по часам и месяцам, пока R не задан.
          </p>
        </div>
      )}
    </section>
  );
}

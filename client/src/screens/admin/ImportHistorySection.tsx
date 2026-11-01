import { useState } from "react";
import { ApiError, importBingxHistory } from "../../api/client";
import type { BingxImportResult, ImportedTradeView } from "../../api/types";

/**
 * Восстановление истории сделок из журнала ордеров BingX (01.11.2026). Появилось после
 * блокировки аккаунта Railway: база с историей осталась недоступна, а биржа свои ордера
 * помнит.
 *
 * Два шага намеренно: сначала «Посмотреть», который ничего не пишет, и только потом
 * «Импортировать». История — основа всей статистики, и увидеть, что именно нашлось,
 * важнее, чем сэкономить нажатие. Повторный импорт безопасен: сделки с уже известным
 * ордером входа помечаются как дубль и пропускаются.
 */

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

function TradeRow({ trade }: { trade: ImportedTradeView }) {
  const r = trade.resultR;
  const rColor = r === null ? "text-slate-400" : r > 0 ? "text-emerald-600" : r < 0 ? "text-red-600" : "text-slate-500";
  return (
    <li className={`flex items-center justify-between gap-2 py-1 ${trade.duplicate ? "opacity-40" : ""}`}>
      <span className="flex min-w-0 flex-col">
        <span className="text-xs text-ink">
          {trade.symbol.replace(/-USDT$/, "")} · {trade.side === "long" ? "лонг" : "шорт"} · {outcomeLabel(trade)}
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

export function ImportHistorySection() {
  const [days, setDays] = useState(30);
  const [result, setResult] = useState<BingxImportResult | null>(null);
  const [isBusy, setIsBusy] = useState(false);
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

  return (
    <section className="flex flex-col gap-3 pt-6">
      <div>
        <h2 className="text-sm font-medium text-ink">История с BingX</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Восстанавливает закрытые сделки из журнала ордеров биржи. Сначала посмотри, что
          нашлось, — предпросмотр ничего не пишет.
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
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={isBusy}
          onClick={() => run(true)}
          className="flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink disabled:opacity-60"
        >
          {isBusy ? "Смотрю…" : "Посмотреть, что найдётся"}
        </button>
        <button
          type="button"
          disabled={isBusy || fresh.length === 0}
          onClick={() => run(false)}
          className="flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Импортировать{fresh.length > 0 ? ` (${fresh.length})` : ""}
        </button>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
      {notice && <p className="text-xs text-emerald-600">{notice}</p>}

      {result && (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-card p-3">
          <p className="text-[11px] text-slate-500">
            Ордеров получено: {result.ordersFetched} · собрано сделок: {result.trades.length} ·
            новых: {fresh.length}
          </p>
          {result.trades.length > 0 && (
            <ul className="flex max-h-72 flex-col overflow-y-auto">
              {result.trades.map((trade) => (
                <TradeRow key={trade.orderIds.entry.join("-")} trade={trade} />
              ))}
            </ul>
          )}
          {result.trades.length === 0 && (
            <p className="text-xs text-slate-500">
              Биржа не отдала закрытых сделок за этот период. Попробуй меньшую глубину:
              история ордеров у BingX хранится ограниченное время.
            </p>
          )}
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
            Что не восстанавливается: пресет R/R, с которым входили, ручные пометки исхода
            и привязка выводов к уровням — биржа этого не помнит. R считается по стоп-ордеру;
            если стопа в истории нет, сделка импортируется без R — она попадёт в список
            сделок, но не в месячную статистику, пока R не задан.
          </p>
        </div>
      )}
    </section>
  );
}

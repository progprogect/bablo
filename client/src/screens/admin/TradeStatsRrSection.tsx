import { useEffect, useState } from "react";
import {
  ApiError,
  getStatsRrTrades,
  recalculateTradeResultRequest,
  setTradeStatsOutcomeRequest,
  setTradeStatsRrPresetRequest,
  type StatsRrAdminTrade,
  type TradeOutcome,
} from "../../api/client";
import { formatSignedUsd } from "../../lib/format";

const RR_PRESETS = ["1/1", "1/1.5", "1/2", "1/3", "1/4", "1/5", "1/6", "1/7", "1/8", "1/9", "1/10"];
const PAGE_SIZE = 40;
const AUTO_VALUE = "__auto__";
const NONE_VALUE = "none";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function presetLabel(preset: string | null): string {
  if (!preset) return "—";
  const parts = preset.split("/");
  return `${parts[1] ?? preset}R`;
}

function selectValue(trade: StatsRrAdminTrade): string {
  if (trade.statsRrPreset == null) return AUTO_VALUE;
  return trade.statsRrPreset;
}

const OUTCOME_LABELS: Record<TradeOutcome, string> = {
  tp: "Тейк",
  sl: "Стоп",
  be: "Б/У",
  other: "—",
};

/** Ручной исход можно задать только из этих значений; "other" — только авто-результат. */
const MANUAL_OUTCOMES: TradeOutcome[] = ["tp", "sl", "be"];

function outcomeSelectValue(trade: StatsRrAdminTrade): string {
  return trade.statsOutcome ?? AUTO_VALUE;
}

/** «+2R» / «−1R» — R, который идёт в суммы статистики. */
function rLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return `${rounded > 0 ? "+" : ""}${rounded}R`;
}

function pnlUsd(trade: StatsRrAdminTrade): number | null {
  if (trade.resultR === null || trade.riskUsd === null) return null;
  return Number(trade.resultR) * Number(trade.riskUsd);
}

/**
 * Админ: история закрытых сделок и ручная правка столбца R в месячной статистике.
 * Список сделок в Истории (rrPreset) не меняется — только сетка на вкладке «Статистика».
 */
export function TradeStatsRrSection() {
  const [trades, setTrades] = useState<StatsRrAdminTrade[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function reload(offset = 0, append = false) {
    getStatsRrTrades(PAGE_SIZE, offset)
      .then((page) => {
        setTrades((prev) => (append && prev ? [...prev, ...page.trades] : page.trades));
        setTotal(page.total);
        setError(null);
      })
      .catch((err) => {
        if (!append) setTrades([]);
        setError(err instanceof ApiError ? err.message : "Не удалось загрузить сделки");
      });
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleChange(tradeId: number, value: string) {
    setError(null);
    setNotice(null);
    setBusyId(tradeId);
    const statsRrPreset = value === AUTO_VALUE ? null : value;
    try {
      await setTradeStatsRrPresetRequest(tradeId, statsRrPreset);
      setNotice("Сохранено для статистики");
      reload(0, false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
    } finally {
      setBusyId(null);
    }
  }

  async function handleOutcomeChange(tradeId: number, value: string) {
    setError(null);
    setNotice(null);
    setBusyId(tradeId);
    const statsOutcome = value === AUTO_VALUE ? null : value;
    try {
      await setTradeStatsOutcomeRequest(tradeId, statsOutcome);
      setNotice(
        statsOutcome === null
          ? "Исход снова определяется автоматически"
          : `Сделка учитывается как «${OUTCOME_LABELS[statsOutcome as TradeOutcome]}» во всей статистике`,
      );
      reload(0, false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить исход");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRecalculate(tradeId: number) {
    setError(null);
    setNotice(null);
    setBusyId(tradeId);
    try {
      const result = await recalculateTradeResultRequest(tradeId);
      const { trade: updated, source, beforeR, afterR, changed } = result;
      const pnl =
        afterR !== null && updated.riskUsd !== null ? afterR * Number(updated.riskUsd) : null;
      const sourceLabel =
        source === "bingx" ? "по fill BingX" : source === "sl" ? "по цене SL" : "по цене закрытия";
      if (!changed) {
        setNotice(
          pnl !== null
            ? `Без изменений ${sourceLabel}: ${formatSignedUsd(pnl)} (${(afterR ?? 0).toFixed(2)}R)`
            : `Без изменений ${sourceLabel}`,
        );
      } else {
        const beforeLabel =
          beforeR !== null && Number.isFinite(beforeR) ? `${beforeR.toFixed(2)}R` : "—";
        const afterLabel =
          afterR !== null && Number.isFinite(afterR) ? `${afterR.toFixed(2)}R` : "—";
        setNotice(
          pnl !== null
            ? `Пересчитано ${sourceLabel}: ${beforeLabel} → ${afterLabel} (${formatSignedUsd(pnl)})`
            : `Пересчитано ${sourceLabel}: ${beforeLabel} → ${afterLabel}`,
        );
      }
      reload(0, false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось пересчитать");
    } finally {
      setBusyId(null);
    }
  }

  const loaded = trades?.length ?? 0;

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div>
        <h2 className="text-sm font-medium text-ink">R в статистике</h2>
        <p className="mt-1 text-xs text-slate-500">
          Закрытые сделки: исход (тейк / стоп / Б/У), столбец R и пересчёт PnL (fill BingX /
          цена закрытия / SL при нулевом close). Исход и столбец R влияют на всю статистику:
          месячная разбивка, сумма R, «+R / −R», винрейт, подсказки и подпись в Истории.
          Причину закрытия с биржи и суммы в USDT не меняют — деньги остаются фактическими.
        </p>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
      {notice && <p className="text-xs text-emerald-600">{notice}</p>}

      {trades === null ? (
        <p className="text-xs text-slate-500">Загрузка…</p>
      ) : trades.length === 0 ? (
        <p className="text-xs text-slate-500">Нет закрытых сделок.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {trades.map((trade) => {
            const pnl = pnlUsd(trade);
            const busy = busyId === trade.id;
            const overridden = trade.statsRrPreset != null;
            const factualR = trade.resultR !== null ? Number(trade.resultR) : null;
            const outcomeOverridden = trade.statsOutcome != null;
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
                        {trade.side === "long" ? "лонг" : "шорт"}
                        {trade.rrPreset ? ` · план ${presetLabel(trade.rrPreset)}` : ""}
                      </span>
                    </p>
                    <p className="text-xs text-slate-500">
                      {formatDate(trade.closedAt ?? trade.openedAt)}
                      {" · R авто "}
                      {presetLabel(trade.autoStatsRrPreset)}
                      {overridden ? ` → ${presetLabel(trade.effectiveStatsRrPreset)}` : ""}
                      {" · исход "}
                      {outcomeOverridden
                        ? `${OUTCOME_LABELS[trade.autoOutcome]} → ${OUTCOME_LABELS[trade.effectiveOutcome]} (вручную)`
                        : OUTCOME_LABELS[trade.effectiveOutcome]}
                    </p>
                    {/* Видно, что реально уходит в суммы статистики: при ручном столбце R
                        показываем и факт, иначе цифра в отчёте выглядела бы необъяснимой. */}
                    <p className="text-xs text-slate-500">
                      В статистику: {rLabel(trade.effectiveStatsResultR)}
                      {overridden && factualR !== null && factualR !== trade.effectiveStatsResultR
                        ? ` (факт ${rLabel(factualR)})`
                        : ""}
                    </p>
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
                {/* flex-wrap: на узком экране два селекта и кнопка переносятся, а не сжимаются
                    до нечитаемого состояния. */}
                <div className="flex flex-wrap gap-2">
                  <select
                    disabled={busy}
                    value={outcomeSelectValue(trade)}
                    onChange={(event) => handleOutcomeChange(trade.id, event.target.value)}
                    className="min-w-[7.5rem] flex-1 rounded-lg border border-line bg-card px-2 py-1.5 text-xs text-ink outline-none focus:border-accent disabled:opacity-50"
                    title="Как сделка учитывается в статистике: тейк, стоп или безубыток"
                  >
                    <option value={AUTO_VALUE}>Исход: авто ({OUTCOME_LABELS[trade.autoOutcome]})</option>
                    {MANUAL_OUTCOMES.map((outcome) => (
                      <option key={outcome} value={outcome}>
                        Исход: {OUTCOME_LABELS[outcome]}
                      </option>
                    ))}
                  </select>
                  <select
                    disabled={busy}
                    value={selectValue(trade)}
                    onChange={(event) => handleChange(trade.id, event.target.value)}
                    className="min-w-[7.5rem] flex-1 rounded-lg border border-line bg-card px-2 py-1.5 text-xs text-ink outline-none focus:border-accent disabled:opacity-50"
                  >
                    <option value={AUTO_VALUE}>
                      R: авто{trade.autoStatsRrPreset ? ` (${presetLabel(trade.autoStatsRrPreset)})` : " (—)"}
                    </option>
                    <option value={NONE_VALUE}>R: не учитывать</option>
                    {RR_PRESETS.map((preset) => (
                      <option key={preset} value={preset}>
                        R: {presetLabel(preset)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      (trade.closePrice === null &&
                        !(trade.closeReason === "sl" && trade.slPrice != null))
                    }
                    onClick={() => handleRecalculate(trade.id)}
                    className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink disabled:opacity-50"
                    title="Пересчитать PnL по fill BingX / цене закрытия / SL"
                  >
                    {busy ? "…" : "Пересчитать"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {trades !== null && loaded < total && (
        <button
          type="button"
          onClick={() => reload(loaded, true)}
          className="rounded-lg border border-line py-2 text-xs font-medium text-ink"
        >
          Ещё ({loaded} из {total})
        </button>
      )}
    </section>
  );
}

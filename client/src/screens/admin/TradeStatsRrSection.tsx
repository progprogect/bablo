import { useEffect, useState } from "react";
import {
  ApiError,
  getStatsRrTrades,
  setTradeStatsRrPresetRequest,
  type StatsRrAdminTrade,
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

  const loaded = trades?.length ?? 0;

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div>
        <h2 className="text-sm font-medium text-ink">R в статистике</h2>
        <p className="mt-1 text-xs text-slate-500">
          Закрытые сделки: какой столбец (1R…10R) учитывать на вкладке «Статистика». В списке
          сделок Истории отображение не меняется. «Авто» — по правилам (partial / тейк / ночной
          стоп), «Не учитывать» — убрать из сетки.
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
                      {" · авто "}
                      {presetLabel(trade.autoStatsRrPreset)}
                      {overridden ? ` → сейчас ${presetLabel(trade.effectiveStatsRrPreset)}` : ""}
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
                <select
                  disabled={busy}
                  value={selectValue(trade)}
                  onChange={(event) => handleChange(trade.id, event.target.value)}
                  className="rounded-lg border border-line bg-card px-2 py-1.5 text-xs text-ink outline-none focus:border-accent disabled:opacity-50"
                >
                  <option value={AUTO_VALUE}>
                    Авто{trade.autoStatsRrPreset ? ` (${presetLabel(trade.autoStatsRrPreset)})` : " (—)"}
                  </option>
                  <option value={NONE_VALUE}>Не учитывать</option>
                  {RR_PRESETS.map((preset) => (
                    <option key={preset} value={preset}>
                      {presetLabel(preset)}
                    </option>
                  ))}
                </select>
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

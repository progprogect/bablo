import { useState } from "react";
import { ApiError, setIntuitiveOutcomeRequest } from "../../api/client";
import type { Trade } from "../../api/types";
import { formatRatioR, formatSignedUsd, roundR } from "../../lib/format";

/**
 * Подпись по фактическому исходу с сервера (history/outcome.ts), а не по типу
 * сработавшего ордера: стоп, уведённый в прибыль ночным правилом, — это тейк, и в
 * статистике он тоже считается тейком. Для "manual"/"external" (закрыта вручную или
 * обнаружено постфактум на BingX) подписи нет: длительность и R/R уже понятны
 * без дополнительного слова.
 */
const OUTCOME_LABELS: Record<string, string> = {
  sl: "По стопу",
  tp: "По тейку",
  be: "Безубыток",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(openedAt: string, closedAt: string | null): string {
  if (!closedAt) return "—";
  const ms = new Date(closedAt).getTime() - new Date(openedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

/**
 * R/R сделки по ФАКТУ — сколько R она реально дала, в том же виде «R/R 1/x», в котором
 * карточка показывала план до 15.08.2026. Значение берём с сервера (`statsResultR`: тот же
 * R, что идёт во всю статистику, с учётом ручного столбца R из админки), иначе из resultR.
 *
 * Знак не выводим: он уже виден по подписи исхода («По стопу» / «По тейку») и по цвету
 * суммы в USDT справа, а «1/−1.1» ломало бы привычный вид карточки. При нулевом R
 * (безубыток) соотношение не показываем вовсе — «R/R 1/0» ничего не сообщает.
 */
function factualRatio(trade: Trade): string | null {
  const raw = trade.statsResultR ?? (trade.resultR !== null ? Number(trade.resultR) : null);
  if (raw === null || !Number.isFinite(raw)) return null;
  if (roundR(Math.abs(raw)) === 0) return null;
  return formatRatioR(raw);
}

/** Реализованный результат в USDT: resultR × риск сделки в $. */
function realizedPnlUsd(trade: Trade): number | null {
  if (trade.resultR === null || trade.riskUsd === null) return null;
  return Number(trade.resultR) * Number(trade.riskUsd);
}

/**
 * ПОЛНАЯ реализованная П/У по данным БИРЖИ (`exchangePnlUsd` с сервера, см.
 * `GET /api/trades` и `matchTradeNetPnl`): реализованный PnL плюс комиссии, funding и
 * прочие начисления за время жизни сделки, без переводов. Именно столько сделка
 * реально принесла или стоила — одного PnL закрытия мало, комиссии входа и выхода его
 * заметно съедают (правка от 16.10.2026: до неё здесь был чистый PnL закрытия).
 *
 * Это не то же самое, что сумма строкой выше: наша считается от `resultR × риск сделки`
 * и комиссий не знает вовсе. Определение здесь то же, что у итога месяца в детализации,
 * поэтому карточки сделок и цифра месяца говорят об одном и том же.
 *
 * Приходит не всегда — нет ключей, журнал кончился по глубине хранения BingX или
 * выборка неполная; тогда строку просто не показываем, вместо прочерка.
 */
function exchangePnlUsd(trade: Trade): number | null {
  const value = trade.exchangePnlUsd;
  return value === null || value === undefined || !Number.isFinite(value) ? null : value;
}

export function TradeRow({
  trade,
  onTradeUpdated,
}: {
  trade: Trade;
  /** Приходит из «Истории»: обновить сделку в загруженном списке после правки отметки. */
  onTradeUpdated?: (trade: Trade) => void;
}) {
  const [isEditingIntuitive, setIsEditingIntuitive] = useState(false);
  const [isSavingIntuitive, setIsSavingIntuitive] = useState(false);
  const [intuitiveError, setIntuitiveError] = useState<string | null>(null);
  const displayName = trade.symbol.replace(/-USDT$/, "");
  const pnlUsd = realizedPnlUsd(trade);
  const exchangePnl = exchangePnlUsd(trade);
  const ratio = factualRatio(trade);
  const isProfit = pnlUsd !== null && pnlUsd > 0;
  const isLoss = pnlUsd !== null && pnlUsd < 0;
  // Старые ответы API без outcome — откат на closeReason, чтобы подпись не пропала.
  const outcome = trade.outcome ?? trade.closeReason ?? undefined;
  const closeReasonLabel = outcome ? OUTCOME_LABELS[outcome] : undefined;

  /**
   * «Интуитивное вмешательство» — сделка закрыта мимо своих SL/TP (вручную на бирже или
   * кнопкой), ещё до того как дошла до них. У такой сделки спрашиваем, как она закрылась
   * бы, если её не трогать.
   *
   * Розовым и с кнопками — только пока отметки НЕТ (просьба пользователя от 23.11.2026):
   * розовый тут не метка «сделка особенная», а напоминание «ответь на вопрос». После
   * ответа исход известен, сделка становится обычной строкой истории — и менять отметку
   * уже нечем: решение принято один раз (переразметка осталась в админке).
   */
  const isIntuitive = trade.closeReason !== "sl" && trade.closeReason !== "tp";
  const hasIntuitiveMark = trade.intuitiveOutcome === "tp" || trade.intuitiveOutcome === "sl";
  const needsIntuitiveMark = isIntuitive && !hasIntuitiveMark;

  async function saveIntuitiveOutcome(value: "tp" | "sl") {
    setIsSavingIntuitive(true);
    setIntuitiveError(null);
    try {
      const updated = await setIntuitiveOutcomeRequest(trade.id, value);
      onTradeUpdated?.(updated);
      setIsEditingIntuitive(false);
    } catch (err) {
      setIntuitiveError(err instanceof ApiError ? err.message : "Не удалось сохранить отметку");
    } finally {
      setIsSavingIntuitive(false);
    }
  }

  return (
    <div
      className={`mx-4 flex flex-col gap-2 rounded-2xl border p-4 shadow-sm ${
        needsIntuitiveMark ? "border-pink-200 bg-pink-50/70" : "border-line bg-card"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{displayName}</span>
          <span
            className={
              trade.side === "long"
                ? "rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-600"
                : "rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600"
            }
          >
            {trade.side === "long" ? "Лонг" : "Шорт"}
          </span>
          {trade.partialTpFilledAt && (
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
              частичная 70%
            </span>
          )}
        </div>
        <span className="text-xs text-slate-500">{formatDate(trade.openedAt)}</span>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500">
        {/* Вид строки — как до 15.08.2026 («R/R 1/1.5»), но значение фактическое, а не
            плановое, и округлённое до десятых. */}
        <span>
          {formatDuration(trade.openedAt, trade.closedAt)}
          {ratio ? ` · R/R ${ratio}` : ""}
          {closeReasonLabel ? ` · ${closeReasonLabel}` : ""}
        </span>
        <span
          className={
            isProfit
              ? "text-sm font-medium text-emerald-600"
              : isLoss
                ? "text-sm font-medium text-red-600"
                : "text-sm font-medium text-slate-600"
          }
        >
          {formatSignedUsd(pnlUsd)}
        </span>
      </div>

      {needsIntuitiveMark && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-pink-200/70 pt-2 text-[11px]">
          <span className="text-pink-700">Как закрылась бы, если не трогать?</span>
          {isEditingIntuitive ? (
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={isSavingIntuitive}
                onClick={() => saveIntuitiveOutcome("tp")}
                className="rounded-md bg-emerald-100 px-2 py-1 font-medium text-emerald-700 disabled:opacity-50"
              >
                по тейку
              </button>
              <button
                type="button"
                disabled={isSavingIntuitive}
                onClick={() => saveIntuitiveOutcome("sl")}
                className="rounded-md bg-red-100 px-2 py-1 font-medium text-red-700 disabled:opacity-50"
              >
                по стопу
              </button>
              <button
                type="button"
                disabled={isSavingIntuitive}
                onClick={() => setIsEditingIntuitive(false)}
                className="rounded-md px-2 py-1 text-slate-500 disabled:opacity-50"
              >
                отмена
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setIsEditingIntuitive(true)}
              className="rounded-md px-2 py-1 font-medium text-pink-700 underline-offset-2 hover:underline"
            >
              редактировать
            </button>
          )}
          {intuitiveError && <span className="w-full text-red-600">{intuitiveError}</span>}
        </div>
      )}

      {exchangePnl !== null && (
        <div className="flex items-baseline justify-between border-t border-line pt-2 text-[11px] text-slate-400">
          <span>Реализованная П/У · BingX</span>
          <span className="tabular-nums">{formatSignedUsd(exchangePnl)}</span>
        </div>
      )}
    </div>
  );
}

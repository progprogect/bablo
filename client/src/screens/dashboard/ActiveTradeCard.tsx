import { useState } from "react";
import { ApiError, closeTradeRequest, setTakeProfitRequest } from "../../api/client";
import type { ActiveTradeView } from "../../api/types";

const RR_PRESETS = ["1/1", "1/1.5", "1/2", "1/3", "1/4", "1/5", "1/6", "1/7"];

function fmt(value: string | number | null | undefined, digits = 4): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function riskReward(trade: ActiveTradeView): string | null {
  if (!trade.tpPrice || !trade.entryPrice || !trade.slPrice) return null;
  const entry = Number(trade.entryPrice);
  const sl = Number(trade.slPrice);
  const tp = Number(trade.tpPrice);
  const risk = Math.abs(entry - sl);
  if (risk === 0) return null;
  const reward = Math.abs(tp - entry);
  return `1 / ${(reward / risk).toFixed(2)}`;
}

/** PnL по живой цене (USDT-M linear: delta цены × кол-во монет, с учётом направления). */
function computeLivePnl(trade: ActiveTradeView, livePrice: number): number | null {
  const entry = Number(trade.entryPrice);
  const qty = Number(trade.quantity);
  if (!Number.isFinite(entry) || !Number.isFinite(qty)) return null;
  const delta = trade.side === "long" ? livePrice - entry : entry - livePrice;
  return delta * qty;
}

export function ActiveTradeCard({
  trade,
  livePrice,
  onUpdated,
  onClosed,
}: {
  trade: ActiveTradeView;
  /** Живая цена из SSE — если есть, PnL считается ею на клиенте (без доп. событий с сервера). */
  livePrice?: number;
  onUpdated: (trade: ActiveTradeView) => void;
  onClosed: () => void;
}) {
  const slConfirmed = Boolean(trade.bingxOrderIds?.sl);
  const displayName = trade.symbol.replace(/-USDT$/, "");
  const [isClosing, setIsClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  const unrealizedProfit = livePrice !== undefined ? computeLivePnl(trade, livePrice) : trade.unrealizedProfit;

  async function handleClose() {
    if (!window.confirm("Закрыть сделку по рынку прямо сейчас?")) return;
    setCloseError(null);
    setIsClosing(true);
    try {
      await closeTradeRequest(trade.id);
      onClosed();
    } catch (err) {
      setCloseError(err instanceof ApiError ? err.message : "Не удалось закрыть сделку");
    } finally {
      setIsClosing(false);
    }
  }

  return (
    <div className="mx-4 flex flex-col gap-4 rounded-2xl border border-slate-800 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium text-slate-100">{displayName}</h2>
        <span
          className={
            trade.side === "long"
              ? "rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-medium text-emerald-400"
              : "rounded-full bg-red-500/20 px-3 py-1 text-xs font-medium text-red-400"
          }
        >
          {trade.side === "long" ? "Лонг" : "Шорт"}
        </span>
      </div>

      {!slConfirmed && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
          SL не подтверждён биржей — проверьте позицию на BingX вручную.
        </p>
      )}

      {trade.positionFlat && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          Похоже, позиция уже закрылась на бирже (SL/TP). Нажмите «Закрыть сделку», чтобы
          зафиксировать результат и снять блокировку новых сделок.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-y-2 text-sm">
        <Row label="Вход" value={fmt(trade.entryPrice)} />
        <Row label="SL" value={fmt(trade.slPrice)} />
        <Row label="TP" value={trade.tpPrice ? fmt(trade.tpPrice) : "не задан"} />
        <Row label="Риск/прибыль" value={riskReward(trade) ?? "—"} />
        <Row label="Сумма риска" value={trade.riskUsd ? `${fmt(trade.riskUsd, 2)} USDT` : "—"} />
        <Row label="Плечо" value={`${trade.leverage}x`} />
        <Row label="Ликвидация" value={fmt(trade.liquidationPrice)} />
        <Row
          label="PnL"
          value={unrealizedProfit !== null ? `${fmt(unrealizedProfit, 2)} USDT` : "—"}
        />
      </dl>

      {!trade.tpPrice && <TakeProfitForm trade={trade} onUpdated={onUpdated} />}

      <button
        type="button"
        disabled={isClosing}
        onClick={handleClose}
        className="rounded-xl border border-red-500/40 py-2 text-sm font-medium text-red-400 disabled:opacity-50"
      >
        {isClosing ? "Закрываю…" : "Закрыть сделку"}
      </button>
      {closeError && <p className="text-center text-xs text-red-400">{closeError}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-slate-100">{value}</dd>
    </div>
  );
}

function TakeProfitForm({
  trade,
  onUpdated,
}: {
  trade: ActiveTradeView;
  onUpdated: (trade: ActiveTradeView) => void;
}) {
  const [tpPrice, setTpPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(input: { tpPrice?: number; rrPreset?: string }) {
    setError(null);
    setIsSubmitting(true);
    try {
      const updated = await setTakeProfitRequest(trade.id, input);
      onUpdated({ ...trade, ...updated });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось выставить TP");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-slate-800 pt-3">
      <p className="text-xs text-slate-500">Выберите соотношение риск/прибыль или укажите цену TP</p>

      <div className="flex flex-wrap gap-2">
        {RR_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={isSubmitting}
            onClick={() => submit({ rrPreset: preset })}
            className="rounded-full border border-slate-800 px-3 py-1 text-xs text-slate-300 disabled:opacity-50"
          >
            {preset}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          type="number"
          inputMode="decimal"
          placeholder="Цена TP вручную"
          value={tpPrice}
          onChange={(event) => setTpPrice(event.target.value)}
          className="flex-1 rounded-lg border border-slate-800 bg-transparent px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
        />
        <button
          type="button"
          disabled={isSubmitting || !tpPrice}
          onClick={() => submit({ tpPrice: Number(tpPrice) })}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-surface disabled:opacity-50"
        >
          Сохранить
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

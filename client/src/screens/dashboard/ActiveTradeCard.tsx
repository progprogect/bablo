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
  const [partialTpWarning, setPartialTpWarning] = useState<string | null>(null);

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
    <div className="mx-4 flex flex-col gap-4 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium text-ink">{displayName}</h2>
        <span
          className={
            trade.side === "long"
              ? "rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700"
              : "rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-700"
          }
        >
          {trade.side === "long" ? "Лонг" : "Шорт"}
        </span>
      </div>

      {!slConfirmed && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
          SL не подтверждён биржей — проверьте позицию на BingX вручную.
        </p>
      )}

      {trade.positionFlat && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Похоже, позиция уже закрылась на бирже (SL/TP). Нажмите «Закрыть сделку», чтобы
          зафиксировать результат и снять блокировку новых сделок.
        </p>
      )}

      {partialTpWarning && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{partialTpWarning}</p>
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

      {trade.partialTpPrice && (
        <div className="flex items-center justify-between rounded-lg bg-accent/5 px-3 py-2 text-xs">
          <span className="flex items-center gap-1.5 text-ink">
            Частичная фиксация {fmt(trade.partialTpPrice)}
            <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
              70%
            </span>
          </span>
          <span className={trade.partialTpFilledAt ? "text-emerald-700" : "text-slate-500"}>
            {trade.partialTpFilledAt ? `исполнена по ${fmt(trade.partialTpFillPrice)}` : "ожидает"}
          </span>
        </div>
      )}

      {!trade.tpPrice && (
        <TakeProfitForm
          trade={trade}
          onUpdated={onUpdated}
          onWarning={setPartialTpWarning}
        />
      )}

      <button
        type="button"
        disabled={isClosing}
        onClick={handleClose}
        className="rounded-xl border border-red-200 py-2 text-sm font-medium text-red-600 disabled:opacity-50"
      >
        {isClosing ? "Закрываю…" : "Закрыть сделку"}
      </button>
      {closeError && <p className="text-center text-xs text-red-600">{closeError}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

function TakeProfitForm({
  trade,
  onUpdated,
  onWarning,
}: {
  trade: ActiveTradeView;
  onUpdated: (trade: ActiveTradeView) => void;
  onWarning: (message: string | null) => void;
}) {
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [tpPrice, setTpPrice] = useState("");
  const [partialTpPrice, setPartialTpPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function pickPreset(preset: string) {
    setSelectedPreset(preset);
    setTpPrice("");
  }

  function editTpPrice(value: string) {
    setTpPrice(value);
    setSelectedPreset(null);
  }

  async function handleSave() {
    if (!selectedPreset && !tpPrice) return;
    setError(null);
    onWarning(null);
    setIsSubmitting(true);
    try {
      const input = selectedPreset ? { rrPreset: selectedPreset } : { tpPrice: Number(tpPrice) };
      const parsedPartial = partialTpPrice ? Number(partialTpPrice) : undefined;
      const { trade: updated, partialTpWarning } = await setTakeProfitRequest(trade.id, {
        ...input,
        ...(parsedPartial !== undefined ? { partialTpPrice: parsedPartial } : {}),
      });
      onUpdated({ ...trade, ...updated });
      onWarning(partialTpWarning);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось выставить TP");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <p className="text-xs text-slate-500">Выберите соотношение риск/прибыль или укажите цену TP</p>

      <div className="flex flex-wrap gap-2">
        {RR_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={isSubmitting}
            onClick={() => pickPreset(preset)}
            className={`rounded-full border px-3 py-1 text-xs disabled:opacity-50 ${
              selectedPreset === preset
                ? "border-accent bg-accent/10 text-accent"
                : "border-line text-slate-600"
            }`}
          >
            {preset}
          </button>
        ))}
      </div>

      <input
        type="number"
        inputMode="decimal"
        placeholder="Цена TP вручную"
        value={tpPrice}
        onChange={(event) => editTpPrice(event.target.value)}
        className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
      />

      <div className="flex items-center gap-2 pt-1">
        <input
          type="number"
          inputMode="decimal"
          placeholder="Цена частичной фиксации (необязательно)"
          value={partialTpPrice}
          onChange={(event) => setPartialTpPrice(event.target.value)}
          className="flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />
        <span className="shrink-0 rounded-full bg-accent/10 px-2 py-1 text-xs font-medium text-accent">
          70%
        </span>
      </div>
      <p className="text-[11px] text-slate-500">
        На этой цене закроется 70% позиции, остальные 30% продолжат идти до TP выше
      </p>

      <button
        type="button"
        disabled={isSubmitting || (!selectedPreset && !tpPrice)}
        onClick={handleSave}
        className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {isSubmitting ? "Сохраняю…" : "Сохранить"}
      </button>

      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

import { useState } from "react";
import { ApiError, closeTradeRequest, setTakeProfitRequest } from "../../api/client";
import type { ActiveTradeView, TradeSide } from "../../api/types";
import { formatPrice, formatSignedUsd, trimTrailingZeros } from "../../lib/format";

const RR_PRESETS = ["1/1", "1/1.5", "1/2", "1/3", "1/4", "1/5", "1/6", "1/7", "1/8", "1/9", "1/10"];

/** "1/2" → 2, "1/1.5" → 1.5. Держим в синхроне с server/src/trades/math.ts. */
function parseRRRatio(preset: string): number | null {
  const match = /^1\/(\d+(\.\d+)?)$/.exec(preset);
  return match?.[1] ? Number(match[1]) : null;
}

/** Держим в синхроне с computeTakeProfitPrice в server/src/trades/math.ts. */
function computeTakeProfitPrice(entryPrice: number, slPrice: number, side: TradeSide, ratio: number): number {
  const riskDistance = Math.abs(entryPrice - slPrice);
  const rewardDistance = riskDistance * ratio;
  return side === "long" ? entryPrice + rewardDistance : entryPrice - rewardDistance;
}

/** Без незначащих нулей — так вычисленную по пресету цену удобно чуть подправить вручную. */
function formatComputedPrice(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/** Соотношение риск/прибыль сделки, если TP уже задан. */
function riskRewardRatio(trade: ActiveTradeView): number | null {
  if (!trade.tpPrice || !trade.entryPrice || !trade.slPrice) return null;
  const entry = Number(trade.entryPrice);
  const sl = Number(trade.slPrice);
  const tp = Number(trade.tpPrice);
  const risk = Math.abs(entry - sl);
  if (risk === 0) return null;
  return Math.abs(tp - entry) / risk;
}

/** PnL по живой цене (USDT-M linear: delta цены × кол-во монет, с учётом направления). */
function computeLivePnl(trade: ActiveTradeView, livePrice: number): number | null {
  const entry = Number(trade.entryPrice);
  const qty = Number(trade.quantity);
  if (!Number.isFinite(entry) || !Number.isFinite(qty)) return null;
  const delta = trade.side === "long" ? livePrice - entry : entry - livePrice;
  return delta * qty;
}

/** Изолированная маржа, выделенная под сделку при открытии (объём × вход / плечо). */
function computeMarginUsd(trade: ActiveTradeView): number | null {
  const entry = Number(trade.entryPrice);
  const qty = Number(trade.quantity);
  if (!Number.isFinite(entry) || !Number.isFinite(qty) || !trade.leverage) return null;
  return (entry * qty) / trade.leverage;
}

/** Потенциальный результат в USDT, если цена дойдёт до заданного уровня (SL/TP). */
function computePotentialPnl(trade: ActiveTradeView, targetPrice: number): number | null {
  const entry = Number(trade.entryPrice);
  const qty = Number(trade.quantity);
  if (!Number.isFinite(entry) || !Number.isFinite(qty)) return null;
  const delta = trade.side === "long" ? targetPrice - entry : entry - targetPrice;
  return delta * qty;
}

export function ActiveTradeCard({
  trade,
  livePrice,
  onUpdated,
  onClosed,
}: {
  trade: ActiveTradeView;
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
  const ratio = riskRewardRatio(trade);
  const riskRewardLabel = ratio !== null ? `1 / ${trimTrailingZeros(ratio)}` : "—";
  const pnlColorClass =
    unrealizedProfit === null
      ? "text-slate-500"
      : unrealizedProfit > 0
        ? "text-emerald-600"
        : unrealizedProfit < 0
          ? "text-red-600"
          : "text-slate-500";
  const marginUsd = computeMarginUsd(trade);
  const potentialLossAtSl = trade.slPrice ? computePotentialPnl(trade, Number(trade.slPrice)) : null;
  const potentialProfitAtTp = trade.tpPrice ? computePotentialPnl(trade, Number(trade.tpPrice)) : null;

  // После настройки TP сделка полностью готова — дальше просто ждём SL/TP, без кнопок,
  // которые создавали бы соблазн что-то вручную докрутить. Кнопка закрытия остаётся только
  // как аварийный путь подтвердить уже закрытую на бирже позицию (positionFlat).
  const isFullyConfigured = Boolean(trade.tpPrice);
  const showCloseButton = !isFullyConfigured || trade.positionFlat;

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
        <div className="flex items-baseline gap-2">
          <h2 className="text-base font-medium text-ink">{displayName}</h2>
          <span className={`text-sm font-semibold ${pnlColorClass}`}>{formatSignedUsd(unrealizedProfit)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={
              trade.side === "long"
                ? "rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700"
                : "rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-700"
            }
          >
            {trade.side === "long" ? "Лонг" : "Шорт"}
          </span>
          <span className="text-xs text-slate-400">{trade.leverage}x</span>
        </div>
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
        <Row label="Вход" value={formatPrice(trade.entryPrice)} />
        <Row label="Текущая цена" value={livePrice !== undefined ? formatPrice(livePrice) : "—"} />
        <Row label="Маржа" value={marginUsd !== null ? `${formatPrice(marginUsd, 2)} USDT` : "—"} />
        <Row
          label="TP"
          value={trade.tpPrice ? `${formatPrice(trade.tpPrice)} / ${formatSignedUsd(potentialProfitAtTp)}` : "не задан"}
        />
        <Row label="Ликвидация" value={formatPrice(trade.liquidationPrice)} />
        <Row
          label="SL"
          value={trade.slPrice ? `${formatPrice(trade.slPrice)} / ${formatSignedUsd(potentialLossAtSl)}` : "—"}
        />
        <Row label="Сумма риска" value={trade.riskUsd ? `${formatPrice(trade.riskUsd, 2)} USDT` : "—"} />
        <Row label="Риск/прибыль" value={riskRewardLabel} />
      </dl>

      {trade.partialTpPrice && (
        <div className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-xs">
          <span className="text-ink">Частичная фиксация {formatPrice(trade.partialTpPrice)} · 70%</span>
          <span className={trade.partialTpFilledAt ? "text-emerald-700" : "text-slate-500"}>
            {trade.partialTpFilledAt ? `исполнена по ${formatPrice(trade.partialTpFillPrice)}` : "ожидает"}
          </span>
        </div>
      )}

      {!trade.tpPrice && (
        <TakeProfitForm trade={trade} onUpdated={onUpdated} onWarning={setPartialTpWarning} />
      )}

      {showCloseButton && (
        <button
          type="button"
          disabled={isClosing}
          onClick={handleClose}
          className="rounded-xl border border-red-200 py-2 text-sm font-medium text-red-600 disabled:opacity-50"
        >
          {isClosing ? "Закрываю…" : "Закрыть сделку"}
        </button>
      )}
      {closeError && <p className="text-center text-xs text-red-600">{closeError}</p>}
    </div>
  );
}

function Row({ label, value, full }: { label: string; value: string; full?: boolean }) {
  return (
    <div className={`flex flex-col ${full ? "col-span-2" : ""}`}>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

const inputClass =
  "rounded-xl border border-line bg-surface px-4 py-3 text-center text-ink outline-none focus:border-accent";

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

  /** Эффективный R/R: из выбранного пресета или из введённой цены TP относительно entry/SL. */
  const effectiveRatio = (() => {
    if (selectedPreset) return parseRRRatio(selectedPreset);
    const tp = Number(tpPrice);
    const entry = Number(trade.entryPrice);
    const sl = Number(trade.slPrice);
    if (!Number.isFinite(tp) || !Number.isFinite(entry) || !Number.isFinite(sl)) return null;
    const risk = Math.abs(entry - sl);
    if (!(risk > 0)) return null;
    return Math.abs(tp - entry) / risk;
  })();
  // Синхрон с server PARTIAL_TP_REQUIRED_MIN_RATIO = 5 (пресет 1/5 и выше).
  const partialTpRequired = effectiveRatio !== null && effectiveRatio >= 5;
  const partialTpFilled = partialTpPrice.trim() !== "" && Number.isFinite(Number(partialTpPrice));
  const canSave =
    Boolean(selectedPreset || tpPrice) && (!partialTpRequired || partialTpFilled) && !isSubmitting;

  function pickPreset(preset: string) {
    const ratio = parseRRRatio(preset);
    const entry = Number(trade.entryPrice);
    const sl = Number(trade.slPrice);
    setSelectedPreset(preset);
    if (ratio !== null && Number.isFinite(entry) && Number.isFinite(sl)) {
      setTpPrice(formatComputedPrice(computeTakeProfitPrice(entry, sl, trade.side, ratio)));
    } else {
      setTpPrice("");
    }
  }

  function editTpPrice(value: string) {
    setTpPrice(value);
    setSelectedPreset(null);
  }

  async function handleSave() {
    if (!canSave) return;
    if (partialTpRequired && !partialTpFilled) {
      setError("При R/R 1/5 и выше укажите цену частичной фиксации");
      return;
    }
    setError(null);
    onWarning(null);
    setIsSubmitting(true);
    try {
      // Если пресет всё ещё выбран (поле цены не трогали после клика по нему) — отправляем
      // rrPreset, сервер сам точно пересчитает цену от актуальных entry/SL. Если пользователь
      // подправил значение вручную — отправляем именно его как обычный tpPrice.
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
    <div className="flex flex-col gap-2.5 border-t border-line pt-3">
      <p className="text-sm font-medium text-ink">Шаг 2 — тейк-профит</p>

      <div className="flex flex-wrap gap-1.5">
        {RR_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={isSubmitting}
            onClick={() => pickPreset(preset)}
            className={`rounded-full border px-2.5 py-1 text-xs disabled:opacity-50 ${
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
        placeholder="Цена TP (или выберите R/R выше)"
        value={tpPrice}
        onChange={(event) => editTpPrice(event.target.value)}
        className={inputClass}
      />

      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          placeholder={
            partialTpRequired
              ? "Частичная фиксация (обязательно при 1/5+)"
              : "Частичная фиксация (необязательно)"
          }
          value={partialTpPrice}
          onChange={(event) => setPartialTpPrice(event.target.value)}
          className={`flex-1 ${inputClass}${
            partialTpRequired && !partialTpFilled ? " border-red-400 focus:border-red-500" : ""
          }`}
        />
        <span className="shrink-0 text-xs text-slate-500">70%</span>
      </div>
      {partialTpRequired && !partialTpFilled && (
        <p className="text-xs text-red-600">При R/R 1/5 и выше укажите уровень частичной фиксации 70%</p>
      )}

      <button
        type="button"
        disabled={!canSave}
        onClick={handleSave}
        className="rounded-xl bg-accent py-3 text-sm font-medium text-white disabled:opacity-50"
      >
        {isSubmitting ? "Сохраняю…" : "Сохранить TP"}
      </button>

      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

import { useEffect, useState } from "react";
import { ApiError, getPrice, openTradeRequest } from "../../api/client";
import type { OpenTradeResult, TradeSide } from "../../api/types";

type Phase = "idle" | "side" | "details";

/**
 * Трёхшаговое открытие сделки:
 * 1) «Открыть сделку» — на дашборде только кнопка, без полей;
 * 2) выбор направления (Купить/Продать);
 * 3) объём + SL и подтверждение.
 */
export function TradeForm({
  symbol,
  levelRiskUsd,
  livePrice,
  onOpened,
}: {
  symbol: string;
  levelRiskUsd: number;
  livePrice?: number;
  onOpened: (result: OpenTradeResult) => void;
}) {
  const [restPrice, setRestPrice] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [side, setSide] = useState<TradeSide | null>(null);
  const [quantity, setQuantity] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setRestPrice(null);
    getPrice(symbol)
      .then((result) => setRestPrice(result.price))
      .catch(() => setRestPrice(null));
  }, [symbol]);

  useEffect(() => {
    setPhase("idle");
    setSide(null);
    setQuantity("");
    setSlPrice("");
    setError(null);
  }, [symbol]);

  const currentPrice = livePrice ?? restPrice;

  function resetToIdle() {
    setPhase("idle");
    setSide(null);
    setQuantity("");
    setSlPrice("");
    setError(null);
  }

  function pickSide(nextSide: TradeSide) {
    setError(null);
    setSide(nextSide);
    setPhase("details");
  }

  async function handleConfirm() {
    if (!side) return;
    setError(null);
    const parsedQuantity = Number(quantity);
    const parsedSl = Number(slPrice);

    if (!(parsedQuantity > 0)) {
      setError("Укажите объём позиции больше нуля");
      return;
    }
    if (!(parsedSl > 0)) {
      setError("Укажите цену SL");
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await openTradeRequest({ symbol, side, quantity: parsedQuantity, slPrice: parsedSl });
      onOpened(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось открыть сделку");
    } finally {
      setIsSubmitting(false);
    }
  }

  const lowerError = error?.toLowerCase() ?? "";
  const slFieldError = lowerError.includes("sl");
  const volumeFieldError = lowerError.includes("риск") || lowerError.includes("объём");

  if (phase === "idle") {
    return (
      <div className="flex flex-col gap-3 px-4">
        <div className="rounded-2xl border border-line bg-card p-4 text-center shadow-sm">
          <p className="text-sm text-slate-500">
            {symbol.replace(/-USDT$/, "")} · цена {currentPrice !== null ? currentPrice : "…"}
          </p>
          <p className="mt-1 text-xs text-slate-400">Лимит риска: {levelRiskUsd} USDT</p>
          <button
            type="button"
            onClick={() => setPhase("side")}
            className="mt-4 w-full rounded-xl bg-accent py-3.5 text-sm font-medium text-white transition-transform active:scale-[0.98]"
          >
            Открыть сделку
          </button>
        </div>
      </div>
    );
  }

  if (phase === "side") {
    return (
      <div className="flex flex-col gap-3 px-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            {symbol.replace(/-USDT$/, "")} · {currentPrice !== null ? currentPrice : "…"}
          </p>
          <button
            type="button"
            onClick={resetToIdle}
            className="text-xs text-slate-500 underline-offset-2 hover:underline"
          >
            Отмена
          </button>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => pickSide("long")}
            className="flex-1 rounded-xl bg-emerald-600 py-3.5 font-medium text-white transition-transform active:scale-[0.98]"
          >
            Купить
          </button>
          <button
            type="button"
            onClick={() => pickSide("short")}
            className="flex-1 rounded-xl bg-red-600 py-3.5 font-medium text-white transition-transform active:scale-[0.98]"
          >
            Продать
          </button>
        </div>
      </div>
    );
  }

  const isLong = side === "long";

  return (
    <div className="flex flex-col gap-3 px-4">
      <div className="flex items-center justify-between">
        <span
          className={
            isLong
              ? "rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700"
              : "rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-700"
          }
        >
          {isLong ? "Лонг" : "Шорт"} · цена {currentPrice !== null ? currentPrice : "…"}
        </span>
        <button
          type="button"
          onClick={() => setPhase("side")}
          className="text-xs text-slate-500 underline-offset-2 hover:underline"
        >
          Назад
        </button>
      </div>

      <div className="flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 shadow-sm">
        <input
          type="number"
          inputMode="decimal"
          autoFocus
          placeholder="Объём позиции (кол-во монет)"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          className={`rounded-xl border bg-surface px-4 py-3 text-center text-ink outline-none focus:border-accent ${
            volumeFieldError ? "border-red-500" : "border-line"
          }`}
        />
        <input
          type="number"
          inputMode="decimal"
          placeholder="Цена SL"
          value={slPrice}
          onChange={(event) => setSlPrice(event.target.value)}
          className={`rounded-xl border bg-surface px-4 py-3 text-center text-ink outline-none focus:border-accent ${
            slFieldError ? "border-red-500" : "border-line"
          }`}
        />
      </div>

      <p className="text-center text-xs text-slate-500">Лимит риска: {levelRiskUsd} USDT</p>

      {error && <p className="text-center text-sm text-red-600">{error}</p>}

      <button
        type="button"
        disabled={isSubmitting}
        onClick={handleConfirm}
        className={`rounded-xl py-3.5 font-medium text-white disabled:opacity-50 ${
          isLong ? "bg-emerald-600" : "bg-red-600"
        }`}
      >
        {isSubmitting ? "Открываю…" : isLong ? "Открыть лонг" : "Открыть шорт"}
      </button>
    </div>
  );
}

import { useEffect, useState } from "react";
import { ApiError, getPrice, openTradeRequest } from "../../api/client";
import type { OpenTradeResult, TradeSide } from "../../api/types";

export function TradeForm({
  symbol,
  levelRiskUsd,
  livePrice,
  onOpened,
}: {
  symbol: string;
  levelRiskUsd: number;
  /** Живая цена из SSE (см. api/sse.ts) — приоритетнее REST, обновляется без поллинга. */
  livePrice?: number;
  onOpened: (result: OpenTradeResult) => void;
}) {
  const [restPrice, setRestPrice] = useState<number | null>(null);
  const [quantity, setQuantity] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submittingSide, setSubmittingSide] = useState<TradeSide | null>(null);

  // REST — разовый фолбэк на смену актива, пока не пришёл первый тик по SSE (обычно ≤1с).
  useEffect(() => {
    setRestPrice(null);
    getPrice(symbol)
      .then((result) => setRestPrice(result.price))
      .catch(() => setRestPrice(null));
  }, [symbol]);

  const currentPrice = livePrice ?? restPrice;

  async function handleSubmit(side: TradeSide) {
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

    setSubmittingSide(side);
    try {
      const result = await openTradeRequest({ symbol, side, quantity: parsedQuantity, slPrice: parsedSl });
      onOpened(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось открыть сделку");
    } finally {
      setSubmittingSide(null);
    }
  }

  const lowerError = error?.toLowerCase() ?? "";
  const slFieldError = lowerError.includes("sl");
  const volumeFieldError = lowerError.includes("риск") || lowerError.includes("объём");
  const isSubmitting = submittingSide !== null;

  return (
    <div className="flex flex-col gap-3 px-4">
      <p className="text-center text-sm text-slate-500">
        Текущая цена: {currentPrice !== null ? currentPrice : "…"}
        {" · "}Лимит риска: {levelRiskUsd} USDT
      </p>

      <div className="flex flex-col gap-2">
        <input
          type="number"
          inputMode="decimal"
          placeholder="Объём позиции (кол-во монет)"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          className={`rounded-xl border bg-transparent px-4 py-3 text-center text-slate-100 outline-none focus:border-accent ${
            volumeFieldError ? "border-red-500" : "border-slate-800"
          }`}
        />
        <input
          type="number"
          inputMode="decimal"
          placeholder="Цена SL"
          value={slPrice}
          onChange={(event) => setSlPrice(event.target.value)}
          className={`rounded-xl border bg-transparent px-4 py-3 text-center text-slate-100 outline-none focus:border-accent ${
            slFieldError ? "border-red-500" : "border-slate-800"
          }`}
        />
      </div>

      {error && <p className="text-center text-sm text-red-400">{error}</p>}

      <div className="flex gap-3">
        <button
          type="button"
          disabled={isSubmitting}
          onClick={() => handleSubmit("long")}
          className="flex-1 rounded-xl bg-emerald-500 py-3 font-medium text-surface disabled:opacity-50"
        >
          Купить
        </button>
        <button
          type="button"
          disabled={isSubmitting}
          onClick={() => handleSubmit("short")}
          className="flex-1 rounded-xl bg-red-500 py-3 font-medium text-surface disabled:opacity-50"
        >
          Продать
        </button>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { ApiError, getPrice, openTradeRequest } from "../../api/client";
import type { OpenTradeResult, TradeSide } from "../../api/types";

type Phase = "idle" | "side" | "details";

/**
 * Держим в синхроне с server/src/risk/service.ts — риск сделки должен лежать в пределах
 * ±20% от плана 1R текущего уровня, а не просто не превышать его. Слишком маленький риск
 * так же ломает дисциплину лестницы, как и слишком большой.
 */
const RISK_SIZE_TOLERANCE_RATIO = 0.2;
const TOLERANCE_PCT_LABEL = Math.round(RISK_SIZE_TOLERANCE_RATIO * 100);

function isValidStopLossDirection(currentPrice: number, slPrice: number, side: TradeSide): boolean {
  return side === "long" ? slPrice < currentPrice : slPrice > currentPrice;
}

function computeRiskUsd(currentPrice: number, slPrice: number, quantity: number): number {
  return Math.abs(currentPrice - slPrice) * quantity;
}

function computeMaxQuantity(currentPrice: number, slPrice: number, levelRiskUsd: number): number {
  const distance = Math.abs(currentPrice - slPrice);
  return distance > 0 ? levelRiskUsd / distance : 0;
}

/**
 * Грубая оценка цены ликвидации для изолированной маржи без учёта тиров обслуживающей маржи
 * биржи — этого достаточно для предупреждения "стоп шире ликвидации", точное значение BingX
 * покажет уже после открытия позиции (см. ActiveTradeCard).
 */
function estimateLiquidationPrice(currentPrice: number, leverage: number, side: TradeSide): number {
  const buffer = currentPrice / leverage;
  return side === "long" ? currentPrice - buffer : currentPrice + buffer;
}

type Validation =
  | { status: "empty" }
  | { status: "invalid"; message: string }
  | { status: "ok"; riskUsd: number; estimatedLiquidation: number };

function evaluateTrade(params: {
  currentPrice: number | null;
  quantity: string;
  slPrice: string;
  side: TradeSide;
  levelRiskUsd: number;
  leverage: number;
  minQuantity: number | null;
  minNotionalUsdt: number | null;
  symbolLabel: string;
}): Validation {
  const { currentPrice, quantity, slPrice, side, levelRiskUsd, leverage, minQuantity, minNotionalUsdt, symbolLabel } =
    params;

  if (!quantity || !slPrice || currentPrice === null) {
    return { status: "empty" };
  }

  const parsedQuantity = Number(quantity);
  const parsedSl = Number(slPrice);

  if (!(parsedQuantity > 0)) {
    return { status: "invalid", message: "Укажите объём позиции больше нуля" };
  }
  if (!(parsedSl > 0)) {
    return { status: "invalid", message: "Укажите цену SL" };
  }
  if (!isValidStopLossDirection(currentPrice, parsedSl, side)) {
    return {
      status: "invalid",
      message: side === "long" ? "SL должен быть ниже текущей цены" : "SL должен быть выше текущей цены",
    };
  }

  if (minQuantity !== null && minNotionalUsdt !== null) {
    const notional = parsedQuantity * currentPrice;
    if (parsedQuantity < minQuantity || notional < minNotionalUsdt) {
      return {
        status: "invalid",
        message: `Минимальный объём для ${symbolLabel}: ${minQuantity} монет (≈${minNotionalUsdt} USDT)`,
      };
    }
  }

  const riskUsd = computeRiskUsd(currentPrice, parsedSl, parsedQuantity);
  const minAllowedRisk = levelRiskUsd * (1 - RISK_SIZE_TOLERANCE_RATIO);
  const maxAllowedRisk = levelRiskUsd * (1 + RISK_SIZE_TOLERANCE_RATIO);
  const tolerancePct = Math.round(RISK_SIZE_TOLERANCE_RATIO * 100);

  if (riskUsd > maxAllowedRisk) {
    // Риск можно снизить двумя равноценными способами: уменьшить объём при том же SL,
    // или оставить объём и приблизить SL к цене входа. Показываем обе опции — пользователь
    // сам решает, что удобнее менять, вместо намёка только на один из параметров.
    const targetQuantity = computeMaxQuantity(currentPrice, parsedSl, levelRiskUsd);
    const targetSlDistance = levelRiskUsd / parsedQuantity;
    const suggestedSl = side === "long" ? currentPrice - targetSlDistance : currentPrice + targetSlDistance;
    return {
      status: "invalid",
      message: `Риск ${riskUsd.toFixed(2)} USDT выше плана ${levelRiskUsd} USDT (допуск ±${tolerancePct}%) — уменьшите объём до ≈${targetQuantity.toFixed(4)} монет либо приблизьте SL до ≈${suggestedSl.toFixed(4)}`,
    };
  }
  if (riskUsd < minAllowedRisk) {
    // Симметрично верхней проверке: слишком маленький риск не даёт сделке продвигать
    // лестницу по плану — предлагаем увеличить объём либо отодвинуть SL дальше от входа.
    const targetQuantity = computeMaxQuantity(currentPrice, parsedSl, levelRiskUsd);
    const targetSlDistance = levelRiskUsd / parsedQuantity;
    const suggestedSl = side === "long" ? currentPrice - targetSlDistance : currentPrice + targetSlDistance;
    return {
      status: "invalid",
      message: `Риск ${riskUsd.toFixed(2)} USDT ниже плана ${levelRiskUsd} USDT (допуск ±${tolerancePct}%) — увеличьте объём до ≈${targetQuantity.toFixed(4)} монет либо отодвиньте SL до ≈${suggestedSl.toFixed(4)}`,
    };
  }

  // Критическая проверка, а не просто предупреждение: если ликвидация оценочно наступит
  // раньше стопа, SL физически не успеет сработать — позицию закроет биржа принудительно
  // и на худших условиях. Для лонга это значит "ликвидация выше SL" (цена падает и первой
  // достигает ликвидации), для шорта — "ликвидация ниже SL" (цена растёт и первой достигает
  // ликвидации). Такую сделку открывать нельзя, поэтому это блокирующая ошибка, а не оттенок.
  const estimatedLiquidation = estimateLiquidationPrice(currentPrice, leverage, side);
  const liquidationSafe = side === "long" ? estimatedLiquidation < parsedSl : estimatedLiquidation > parsedSl;
  if (!liquidationSafe) {
    return {
      status: "invalid",
      message:
        side === "long"
          ? `Опасно: ликвидация (≈${estimatedLiquidation.toFixed(4)}) оценочно выше стопа — SL не успеет сработать. Приблизьте SL к цене входа.`
          : `Опасно: ликвидация (≈${estimatedLiquidation.toFixed(4)}) оценочно ниже стопа — SL не успеет сработать. Приблизьте SL к цене входа.`,
    };
  }

  return { status: "ok", riskUsd, estimatedLiquidation };
}

/**
 * Трёхшаговое открытие сделки:
 * 1) «Открыть сделку» — на дашборде только кнопка, без полей;
 * 2) выбор направления (Купить/Продать);
 * 3) объём + SL с живой проверкой риска/минимума/ликвидации до нажатия кнопки.
 */
export function TradeForm({
  symbol,
  leverage,
  levelRiskUsd,
  livePrice,
  blockedReason = null,
  onOpened,
}: {
  symbol: string;
  leverage: number;
  levelRiskUsd: number;
  livePrice?: number;
  /** Если задан — вход в этот актив запрещён (правило #9: стоп по активу сегодня). */
  blockedReason?: string | null;
  onOpened: (result: OpenTradeResult) => void;
}) {
  const [restPrice, setRestPrice] = useState<number | null>(null);
  const [minQuantity, setMinQuantity] = useState<number | null>(null);
  const [minNotionalUsdt, setMinNotionalUsdt] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [side, setSide] = useState<TradeSide | null>(null);
  const [quantity, setQuantity] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setRestPrice(null);
    setMinQuantity(null);
    setMinNotionalUsdt(null);
    getPrice(symbol)
      .then((result) => {
        setRestPrice(result.price);
        setMinQuantity(result.minQuantity);
        setMinNotionalUsdt(result.minNotionalUsdt);
      })
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
  const symbolLabel = symbol.replace(/-USDT$/, "");

  const validation = useMemo(
    () =>
      side
        ? evaluateTrade({
            currentPrice,
            quantity,
            slPrice,
            side,
            levelRiskUsd,
            leverage,
            minQuantity,
            minNotionalUsdt,
            symbolLabel,
          })
        : { status: "empty" as const },
    [currentPrice, quantity, slPrice, side, levelRiskUsd, leverage, minQuantity, minNotionalUsdt, symbolLabel],
  );

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
    if (!side || validation.status !== "ok") return;
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await openTradeRequest({
        symbol,
        side,
        quantity: Number(quantity),
        slPrice: Number(slPrice),
      });
      onOpened(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось открыть сделку");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (phase === "idle") {
    return (
      <div className="flex flex-col gap-3 px-4">
        <div className="rounded-2xl border border-line bg-card p-4 text-center shadow-sm">
          <p className="text-sm text-slate-500">
            {symbolLabel} · цена {currentPrice !== null ? currentPrice : "…"}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            План риска: {levelRiskUsd} USDT (±{TOLERANCE_PCT_LABEL}%)
          </p>
          {blockedReason ? (
            <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-700">
              {blockedReason}
            </p>
          ) : (
            <button
              type="button"
              onClick={() => setPhase("side")}
              className="mt-4 w-full rounded-xl bg-accent py-3.5 text-sm font-medium text-white transition-transform active:scale-[0.98]"
            >
              Открыть сделку
            </button>
          )}
        </div>
      </div>
    );
  }

  if (blockedReason) {
    return (
      <div className="flex flex-col gap-3 px-4">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center">
          <p className="text-sm text-amber-700">{blockedReason}</p>
          <button
            type="button"
            onClick={resetToIdle}
            className="mt-3 text-xs text-amber-700 underline-offset-2 hover:underline"
          >
            Назад
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
            {symbolLabel} · {currentPrice !== null ? currentPrice : "…"}
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
  const hasInvalidIssue = validation.status === "invalid";

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
            hasInvalidIssue ? "border-red-400" : "border-line"
          }`}
        />
        <input
          type="number"
          inputMode="decimal"
          placeholder="Цена SL"
          value={slPrice}
          onChange={(event) => setSlPrice(event.target.value)}
          className={`rounded-xl border bg-surface px-4 py-3 text-center text-ink outline-none focus:border-accent ${
            hasInvalidIssue ? "border-red-400" : "border-line"
          }`}
        />
      </div>

      <ValidationPanel validation={validation} levelRiskUsd={levelRiskUsd} />

      {error && <p className="text-center text-sm text-red-600">{error}</p>}

      <button
        type="button"
        disabled={isSubmitting || validation.status !== "ok"}
        onClick={handleConfirm}
        className={`rounded-xl py-3.5 font-medium text-white disabled:opacity-40 ${
          isLong ? "bg-emerald-600" : "bg-red-600"
        }`}
      >
        {isSubmitting ? "Открываю…" : isLong ? "Открыть лонг" : "Открыть шорт"}
      </button>
    </div>
  );
}

function ValidationPanel({ validation, levelRiskUsd }: { validation: Validation; levelRiskUsd: number }) {
  if (validation.status === "empty") {
    return (
      <p className="rounded-xl bg-surface px-3 py-2.5 text-center text-xs text-slate-500">
        Заполните объём и SL — риск сделки должен быть ≈{levelRiskUsd} USDT (±{TOLERANCE_PCT_LABEL}%)
      </p>
    );
  }

  if (validation.status === "invalid") {
    return (
      <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-center text-xs text-red-700">
        {validation.message}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-800">
      <p className="flex items-center gap-1.5">
        <span aria-hidden>✓</span>
        Риск {validation.riskUsd.toFixed(2)} USDT — соответствует плану {levelRiskUsd} USDT
      </p>
      <p className="flex items-center gap-1.5">
        <span aria-hidden>✓</span>
        Ликвидация (≈{validation.estimatedLiquidation.toFixed(4)}) дальше стопа
      </p>
    </div>
  );
}

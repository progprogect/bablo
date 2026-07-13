import { eventBus, type PriceUpdatedEvent } from "../events/bus.js";
import { updateTradeTracking, type Trade } from "../db/repositories/trades.js";
import type { TradeSide } from "../trades/math.js";
import { applyPriceTick, createTrackingState, type TrackingState } from "./logic.js";

/**
 * Трекер MFE/безубытка активной сделки (Этап 7, docs/RISK_ENGINE.md). Держит состояние
 * в памяти и подписан на тот же внутренний event bus, что и SSE (без REST-поллинга).
 * В любой момент отслеживается не более одной активной сделки — приложение
 * однопользовательское, вторую сделку риск-движок открыть не даст.
 */
type Tracked = { tradeId: number; symbol: string; state: TrackingState };

let tracked: Tracked | null = null;
let listenerAttached = false;

function ensureListener(): void {
  if (listenerAttached) return;
  eventBus.onTyped("price", (event) => {
    void handlePrice(event);
  });
  listenerAttached = true;
}

async function handlePrice({ symbol, price }: PriceUpdatedEvent): Promise<void> {
  if (!tracked || tracked.symbol !== symbol) return;

  const { state, changed } = applyPriceTick(tracked.state, price);
  tracked.state = state;

  if (changed) {
    const { tradeId } = tracked;
    await updateTradeTracking(tradeId, { mfePrice: state.mfePrice, beCrossed: state.beCrossed }).catch((error) => {
      console.error("[tracker] не удалось сохранить MFE/безубыток:", error);
    });
  }
}

/**
 * Начинает трекинг новой активной сделки — вызывается при открытии сделки и при
 * старте сервера, если сделка уже была активна (восстановление после деплоя/рестарта).
 */
export function startTracking(trade: Pick<Trade, "id" | "symbol" | "side" | "entryPrice" | "mfePrice" | "beCrossed">): void {
  const entryPrice = trade.entryPrice !== null ? Number(trade.entryPrice) : null;
  if (entryPrice === null || !Number.isFinite(entryPrice)) {
    tracked = null;
    return;
  }

  ensureListener();
  tracked = {
    tradeId: trade.id,
    symbol: trade.symbol,
    state: createTrackingState(trade.side as TradeSide, entryPrice, {
      mfePrice: trade.mfePrice !== null ? Number(trade.mfePrice) : entryPrice,
      beCrossed: trade.beCrossed,
    }),
  };
}

/** Останавливает трекинг — сделка закрыта. */
export function stopTracking(): void {
  tracked = null;
}

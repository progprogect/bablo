import type { OrderSide } from "../bingx/client.js";
import { getBingxCredentials } from "../db/repositories/settings.js";
import { getTradeById, updateTrade, type Trade } from "../db/repositories/trades.js";
import { eventBus, type PriceUpdatedEvent } from "../events/bus.js";
import type { TradeSide } from "./math.js";
import { replaceConditionalOrder } from "./orders.js";
import { decideTrailingSlMove, trailingLadderFor } from "./trailingSl.js";

/**
 * Вотчер трейлинг-лестницы SL (trades/trailingSl.ts): слушает ту же шину цен, что и
 * MFE-трекер, и при достижении уровня подтягивает стоп через безопасную замену ордера.
 *
 * Одна активная сделка на приложение — контекст одиночный. Дешёвая проверка уровня
 * идёт по данным в памяти на каждом тике; сделка перечитывается из БД только когда
 * уровень действительно достигнут (защита от гонок и устаревшего контекста).
 * Прогресс лестницы хранится в trades.trail_sl_applied_r — каждый уровень двигает
 * стоп один раз, в том числе после рестарта сервера.
 */
type WatchContext = {
  tradeId: number;
  symbol: string;
  side: TradeSide;
  entryPrice: number;
  riskDistance: number;
  ladderTriggers: number[];
  appliedTriggerR: number | null;
  busy: boolean;
  failedAtMs: number | null;
};

let context: WatchContext | null = null;
let listenerAttached = false;

/** После сбоя биржи не молотим её на каждом тике — пауза перед повтором. */
const FAILURE_COOLDOWN_MS = 60_000;

function ensureListener(): void {
  if (listenerAttached) return;
  eventBus.onTyped("price", (event) => {
    void handlePrice(event);
  });
  listenerAttached = true;
}

/**
 * Включает (или выключает) лестницу для сделки — вызывается после установки TP,
 * при старте сервера с активной сделкой и после закрытия. Сама решает, подпадает ли
 * сделка под правило: пресет 1/3 или 1/4, полный тейк (без частичной фиксации).
 */
export function startTrailingSlWatch(trade: Trade): void {
  context = null;
  const ladder = trailingLadderFor(trade.rrPreset);
  if (!ladder) return;
  if (trade.partialTpPrice !== null) return; // правило пользователя: с частичной фиксацией лестница не нужна
  if (trade.status !== "active") return;

  const entryPrice = trade.entryPrice !== null ? Number(trade.entryPrice) : null;
  const riskUsd = trade.riskUsd !== null ? Number(trade.riskUsd) : null;
  const quantity = Number(trade.quantity);
  if (entryPrice === null || !(entryPrice > 0) || riskUsd === null || !(riskUsd > 0) || !(quantity > 0)) {
    return;
  }

  ensureListener();
  context = {
    tradeId: trade.id,
    symbol: trade.symbol,
    side: trade.side as TradeSide,
    entryPrice,
    riskDistance: riskUsd / quantity,
    ladderTriggers: ladder.map((level) => level.triggerR),
    appliedTriggerR: trade.trailSlAppliedR !== null ? Number(trade.trailSlAppliedR) : null,
    busy: false,
    failedAtMs: null,
  };
  console.info(
    `[trailing] лестница SL включена: сделка #${trade.id} ${trade.symbol} (${trade.rrPreset})`,
  );
}

export function stopTrailingSlWatch(): void {
  context = null;
}

async function handlePrice({ symbol, price }: PriceUpdatedEvent): Promise<void> {
  const ctx = context;
  if (!ctx || ctx.symbol !== symbol || ctx.busy) return;
  if (ctx.failedAtMs !== null && Date.now() - ctx.failedAtMs < FAILURE_COOLDOWN_MS) return;

  // Дешёвый предфильтр без БД: есть ли вообще непройденный уровень ниже текущего хода.
  const reachedR =
    ctx.side === "long"
      ? (price - ctx.entryPrice) / ctx.riskDistance
      : (ctx.entryPrice - price) / ctx.riskDistance;
  const hasPending = ctx.ladderTriggers.some(
    (triggerR) =>
      reachedR >= triggerR && (ctx.appliedTriggerR === null || triggerR > ctx.appliedTriggerR),
  );
  if (!hasPending) return;

  ctx.busy = true;
  try {
    await applyTrailingMove(ctx, price);
  } catch (error) {
    ctx.failedAtMs = Date.now();
    console.error("[trailing] перенос SL не удался:", error instanceof Error ? error.message : error);
  } finally {
    ctx.busy = false;
  }
}

async function applyTrailingMove(ctx: WatchContext, price: number): Promise<void> {
  // Свежая сделка из БД — контекст мог отстать (partial добавлена, сделка закрыта).
  const trade = await getTradeById(ctx.tradeId);
  if (!trade || trade.status !== "active" || trade.partialTpPrice !== null) {
    context = null;
    return;
  }

  const decision = decideTrailingSlMove({
    rrPreset: trade.rrPreset,
    side: trade.side as TradeSide,
    entryPrice: Number(trade.entryPrice),
    currentSlPrice: trade.slPrice !== null ? Number(trade.slPrice) : null,
    riskUsd: Number(trade.riskUsd),
    quantity: Number(trade.quantity),
    partialTpPrice: null,
    appliedTriggerR: trade.trailSlAppliedR !== null ? Number(trade.trailSlAppliedR) : null,
    price,
  });

  if (decision.action === "skip") return;

  if (decision.action === "settle") {
    // Стоп уже не хуже целевого (например, ночное правило опередило) — фиксируем уровень.
    await updateTrade(trade.id, { trailSlAppliedR: decision.triggerR });
    ctx.appliedTriggerR = decision.triggerR;
    return;
  }

  const credentials = await getBingxCredentials();
  if (!credentials) {
    ctx.failedAtMs = Date.now();
    return;
  }

  const orderIds = (trade.bingxOrderIds as Record<string, string | number> | null) ?? {};
  const exitSide: OrderSide = trade.side === "long" ? "SELL" : "BUY";
  const targetLabel = decision.slR <= 0 ? "вход (безубыток)" : `+${decision.slR}R`;

  const moved = await replaceConditionalOrder(credentials, {
    symbol: trade.symbol,
    exitSide,
    type: "STOP_MARKET",
    oldOrderId: orderIds.sl,
    oldStopPrice: trade.slPrice !== null ? Number(trade.slPrice) : null,
    newStopPrice: decision.newSlPrice,
    quantity: Number(trade.quantity),
    failureMessage: `Не удалось перенести SL на ${targetLabel} (цена дошла до ${decision.triggerR}R) — проверьте стоп на BingX`,
  });

  if (!moved.ok) {
    if (moved.restoredOrderId !== null) {
      await updateTrade(trade.id, {
        bingxOrderIds: { ...orderIds, sl: moved.restoredOrderId },
      }).catch(() => {});
    }
    ctx.failedAtMs = Date.now();
    console.warn(`[trailing] ${moved.message}`);
    return;
  }

  await updateTrade(trade.id, {
    slPrice: decision.newSlPrice,
    bingxOrderIds: { ...orderIds, sl: moved.orderId },
    trailSlAppliedR: decision.triggerR,
  });
  ctx.appliedTriggerR = decision.triggerR;
  console.info(
    `[trailing] сделка #${trade.id} ${trade.symbol}: цена дошла до ${decision.triggerR}R — SL перенесён на ${targetLabel} (${decision.newSlPrice})`,
  );
  eventBus.emitTyped("refresh", { reason: "trade.slTrailed" });
}

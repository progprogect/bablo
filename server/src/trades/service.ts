import {
  cancelOrder,
  ensureOneWayMode,
  getContractLimits,
  getLatestPrice,
  getPositions,
  placeOrder,
  setLeverage,
  setMarginType,
  type OrderSide,
} from "../bingx/client.js";
import { listActiveAssets, type Asset } from "../db/repositories/assets.js";
import { getBingxCredentials } from "../db/repositories/settings.js";
import {
  closeTradeIfActive,
  createTrade,
  getActiveTrade,
  getTradeById,
  listUnclassifiedClosedTrades,
  updateTrade,
  type Trade,
} from "../db/repositories/trades.js";
import { eventBus } from "../events/bus.js";
import {
  checkCanOpenTrade,
  checkVolumeRisk,
  recordTradeClose,
  resyncTradingDayRisk,
  RiskBlockedError,
} from "../risk/service.js";
import { startTracking, stopTracking } from "../tracker/activeTradeTracker.js";
import {
  computePartialTpQuantity,
  computeResultFromPrices,
  computeRiskUsd,
  computeTakeProfitPrice,
  decimalsOf,
  decideMoveSlAfterPartialOneToThree,
  isValidPartialTakeProfit,
  isValidStopLoss,
  isValidTakeProfit,
  parseRRRatio,
  PARTIAL_TP_PERCENT,
  requiresPartialTakeProfit,
  computeRiskRewardRatio,
  isPartialTakeProfitWithinMaxRatio,
  type TradeSide,
} from "./math.js";

export class TradeError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "TradeError";
  }
}

function bingxMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function getActiveAssetOrThrow(symbol: string): Promise<Asset> {
  const assets = await listActiveAssets();
  const asset = assets.find((a) => a.symbol === symbol);
  if (!asset) {
    throw new TradeError(`Актив ${symbol} не найден или отключён`);
  }
  return asset;
}

export type OpenTradeInput = {
  symbol: string;
  side: TradeSide;
  quantity: number;
  slPrice: number;
};

export type OpenTradeResult = {
  trade: Trade;
  /** Если не null — позиция ОТКРЫТА на бирже, но SL выставить не удалось (нужно ручное действие). */
  slWarning: string | null;
};

/**
 * Открывает сделку: market-вход + немедленный SL. SL валидируется против свежей
 * рыночной цены ДО отправки ордера — так позиция никогда не открывается заведомо
 * с бессмысленным стопом. Если сама биржа всё же не приняла SL после входа
 * (позиция уже реальна), об этом явно сообщается вызывающей стороне.
 */
export async function openTrade(input: OpenTradeInput): Promise<OpenTradeResult> {
  if (!(input.quantity > 0)) {
    throw new TradeError("Объём позиции должен быть больше нуля");
  }
  if (!(input.slPrice > 0)) {
    throw new TradeError("Некорректная цена SL");
  }

  const credentials = await getBingxCredentials();
  if (!credentials) {
    throw new TradeError("Ключи BingX не настроены — добавьте их в админке");
  }

  // Credentials нужны здесь же — проверка захватывает не только БД, но и реальные
  // позиции на BingX (см. checkCanOpenTrade), чтобы не открыть вторую позицию
  // параллельно с уже открытой вручную на бирже.
  try {
    await checkCanOpenTrade(credentials, input.symbol);
  } catch (error) {
    if (error instanceof RiskBlockedError) {
      throw new TradeError(error.message, 409);
    }
    throw error;
  }

  const asset = await getActiveAssetOrThrow(input.symbol);

  let currentPrice: number;
  try {
    currentPrice = await getLatestPrice(asset.symbol);
  } catch (error) {
    throw new TradeError(bingxMessage(error, "Не удалось получить цену с BingX"), 502);
  }

  if (!isValidStopLoss(currentPrice, input.slPrice, input.side)) {
    throw new TradeError(
      input.side === "long" ? "Цена SL должна быть ниже текущей цены" : "Цена SL должна быть выше текущей цены",
    );
  }

  try {
    await checkVolumeRisk(currentPrice, input.slPrice, input.quantity);
  } catch (error) {
    if (error instanceof RiskBlockedError) {
      throw new TradeError(error.message);
    }
    throw error;
  }

  // Понятная проверка минимального объёма ДО отправки на биржу — иначе пользователь увидит
  // сырое сообщение BingX вида "The minimum order amount is 5.073 TIA". Best-effort: если
  // лимиты не удалось получить, не блокируем сделку — решение всё равно примет сама биржа.
  const limits = await getContractLimits(asset.symbol).catch(() => null);
  if (limits) {
    const notionalUsd = input.quantity * currentPrice;
    if (input.quantity < limits.tradeMinQuantity || notionalUsd < limits.tradeMinUSDT) {
      throw new TradeError(
        `Слишком маленький объём. Минимум для ${asset.symbol.replace(/-USDT$/, "")}: ${limits.tradeMinQuantity} монет (≈${limits.tradeMinUSDT} USDT)`,
      );
    }
  }

  try {
    await ensureOneWayMode(credentials);
    await setMarginType(credentials, asset.symbol);
    await setLeverage(credentials, asset.symbol, asset.leverage);
  } catch (error) {
    throw new TradeError(bingxMessage(error, "Не удалось настроить параметры торговли на BingX"), 502);
  }

  const entrySide: OrderSide = input.side === "long" ? "BUY" : "SELL";
  const exitSide: OrderSide = input.side === "long" ? "SELL" : "BUY";

  let marketOrderId: string | number;
  try {
    const marketOrder = await placeOrder(credentials, {
      symbol: asset.symbol,
      side: entrySide,
      type: "MARKET",
      quantity: input.quantity,
    });
    marketOrderId = marketOrder.orderId;
  } catch (error) {
    throw new TradeError(bingxMessage(error, "Не удалось открыть позицию на BingX"), 502);
  }

  // ВАЖНО: позиция на бирже уже реальна с этого момента. Всё, что ниже, — это
  // best-effort защита и запись сделки; ни одна ошибка здесь не должна вылетать
  // необработанной, иначе пользователь не узнает, что позиция открыта без SL.

  // Рыночный ордер исполняется почти мгновенно, но фактическая цена входа может
  // отличаться от currentPrice из-за проскальзывания — читаем её из позиции.
  let entryPrice = currentPrice;
  try {
    const positions = await getPositions(credentials, asset.symbol);
    const position = positions.find((p) => Number(p.positionAmt) !== 0);
    if (position) {
      entryPrice = Number(position.avgPrice);
    }
  } catch {
    // не удалось прочитать позицию — используем currentPrice как приближение,
    // это не критично: SL всё равно ставится по input.slPrice, а не по entryPrice.
  }

  const riskUsd = computeRiskUsd(entryPrice, input.slPrice, input.quantity);
  const bingxOrderIds: Record<string, string | number> = { market: marketOrderId };
  let slWarning: string | null = null;

  try {
    const slOrder = await placeOrder(credentials, {
      symbol: asset.symbol,
      side: exitSide,
      type: "STOP_MARKET",
      stopPrice: input.slPrice,
      quantity: input.quantity,
      reduceOnly: true,
    });
    bingxOrderIds.sl = slOrder.orderId;
  } catch (error) {
    slWarning = bingxMessage(
      error,
      "Позиция открыта, но SL не выставлен на бирже — установите его вручную немедленно",
    );
  }

  try {
    const trade = await createTrade({
      symbol: asset.symbol,
      side: input.side,
      quantity: input.quantity,
      leverage: asset.leverage,
      entryPrice,
      slPrice: input.slPrice,
      riskUsd,
      bingxOrderIds,
    });
    startTracking(trade);
    eventBus.emitTyped("refresh", { reason: "trade.opened" });
    return { trade, slWarning };
  } catch {
    throw new TradeError(
      "Позиция открыта на бирже, но не удалось сохранить сделку в приложении — проверьте позицию на BingX вручную",
      500,
    );
  }
}

export type SetTakeProfitInput = {
  tpPrice?: number;
  rrPreset?: string;
  /** Опциональная цена частичной фиксации PARTIAL_TP_PERCENT% объёма (см. math.ts). */
  partialTpPrice?: number;
};

export type SetTakeProfitResult = {
  trade: Trade;
  /** Если не null — основной TP выставлен, но частичный ордер не удалось поставить на бирже. */
  partialTpWarning: string | null;
};

export async function setTakeProfit(tradeId: number, input: SetTakeProfitInput): Promise<SetTakeProfitResult> {
  const trade = await getTradeById(tradeId);
  if (!trade || trade.status !== "active") {
    throw new TradeError("Активная сделка не найдена", 404);
  }
  // TP (и частичная фиксация вместе с ним) задаётся один раз сразу после открытия сделки —
  // клиент больше не предлагает докидывать частичную фиксацию позже отдельным действием
  // (см. docs/PROJECT.md), поэтому повторный вызов для уже настроенной сделки — явная ошибка.
  if (trade.tpPrice != null) {
    throw new TradeError("TP уже выставлен для этой сделки");
  }

  const entryPrice = Number(trade.entryPrice);
  const slPrice = Number(trade.slPrice);
  const side = trade.side as TradeSide;

  let tpPrice: number;
  let rrPreset: string | undefined;

  if (input.rrPreset) {
    const ratio = parseRRRatio(input.rrPreset);
    if (ratio === null) {
      throw new TradeError("Некорректный пресет соотношения риск/прибыль");
    }
    tpPrice = computeTakeProfitPrice(entryPrice, slPrice, side, ratio);
    rrPreset = input.rrPreset;
  } else if (input.tpPrice !== undefined) {
    tpPrice = input.tpPrice;
  } else {
    throw new TradeError("Укажите tpPrice или rrPreset");
  }

  if (!isValidTakeProfit(entryPrice, tpPrice, side)) {
    throw new TradeError(side === "long" ? "TP должен быть выше цены входа" : "TP должен быть ниже цены входа");
  }

  const effectiveRatio =
    (rrPreset !== undefined ? parseRRRatio(rrPreset) : null) ??
    computeRiskRewardRatio(entryPrice, slPrice, tpPrice);
  if (
    effectiveRatio !== null &&
    requiresPartialTakeProfit(effectiveRatio) &&
    input.partialTpPrice === undefined
  ) {
    throw new TradeError(
      "При R/R 1/5 и выше укажите цену частичной фиксации 70% — без неё дальнюю цель ставить нельзя",
    );
  }

  if (input.partialTpPrice !== undefined && !isValidPartialTakeProfit(entryPrice, tpPrice, input.partialTpPrice, side)) {
    throw new TradeError(
      side === "long"
        ? "Цена частичной фиксации должна быть между входом и TP"
        : "Цена частичной фиксации должна быть между входом и TP (ниже входа, выше TP)",
    );
  }

  if (
    input.partialTpPrice !== undefined &&
    !isPartialTakeProfitWithinMaxRatio(entryPrice, slPrice, input.partialTpPrice)
  ) {
    throw new TradeError("Частичная фиксация не должна быть дальше R/R 1/3 от входа");
  }

  const credentials = await getBingxCredentials();
  if (!credentials) {
    throw new TradeError("Ключи BingX не настроены");
  }

  const exitSide: OrderSide = side === "long" ? "SELL" : "BUY";
  const totalQuantity = Number(trade.quantity);

  // Если задана частичная фиксация — основной TP уходит не на весь объём, а на остаток
  // (100% − PARTIAL_TP_PERCENT%). Так обе цели независимы: срабатывание одной не зависит
  // от способности биржи «урезать» reduceOnly-ордер сверх текущего остатка позиции.
  let partialQuantity: number | null = null;
  let mainTpQuantity = totalQuantity;
  if (input.partialTpPrice !== undefined) {
    partialQuantity = computePartialTpQuantity(totalQuantity, decimalsOf(trade.quantity));
    if (!(partialQuantity > 0) || partialQuantity >= totalQuantity) {
      throw new TradeError("Объём позиции слишком мал для частичной фиксации");
    }
    mainTpQuantity = totalQuantity - partialQuantity;
  }

  let tpOrderId: string | number;
  try {
    const tpOrder = await placeOrder(credentials, {
      symbol: trade.symbol,
      side: exitSide,
      type: "TAKE_PROFIT_MARKET",
      stopPrice: tpPrice,
      quantity: mainTpQuantity,
      reduceOnly: true,
    });
    tpOrderId = tpOrder.orderId;
  } catch (error) {
    throw new TradeError(bingxMessage(error, "Не удалось выставить TP на бирже"), 502);
  }

  let partialTpOrderId: string | number | undefined;
  let partialTpWarning: string | null = null;
  if (input.partialTpPrice !== undefined && partialQuantity !== null) {
    try {
      const partialOrder = await placeOrder(credentials, {
        symbol: trade.symbol,
        side: exitSide,
        type: "TAKE_PROFIT_MARKET",
        stopPrice: input.partialTpPrice,
        quantity: partialQuantity,
        reduceOnly: true,
      });
      partialTpOrderId = partialOrder.orderId;
    } catch (error) {
      partialTpWarning = bingxMessage(
        error,
        "Основной TP выставлен, но частичную фиксацию поставить не удалось — попробуйте ещё раз",
      );
    }
  }

  // TP уже реально выставлен на бирже — ошибка записи в БД не должна выглядеть
  // как отказ всей операции, но должна быть явно видна пользователю.
  try {
    const existingOrderIds = (trade.bingxOrderIds as Record<string, string | number> | null) ?? {};
    const updated = await updateTrade(tradeId, {
      tpPrice,
      rrPreset,
      partialTpPrice: partialTpOrderId !== undefined ? input.partialTpPrice : undefined,
      partialTpPercent: partialTpOrderId !== undefined ? PARTIAL_TP_PERCENT : undefined,
      partialTpQuantity: partialTpOrderId !== undefined ? (partialQuantity ?? undefined) : undefined,
      bingxOrderIds: {
        ...existingOrderIds,
        tp: tpOrderId,
        ...(partialTpOrderId !== undefined ? { partialTp: partialTpOrderId } : {}),
      },
    });
    if (!updated) {
      throw new Error("update returned null");
    }
    return { trade: updated, partialTpWarning };
  } catch {
    throw new TradeError(
      "TP выставлен на бирже, но не удалось сохранить это в приложении — перезагрузите дашборд",
      500,
    );
  }
}

/**
 * Финализирует закрытую сделку: атомарная запись результата (защита от гонки с
 * авто-детектом по WS) + постфактум-фид в риск-движок + событие клиенту на обновление.
 * Вызывается и из ручного closeTrade, и из реалтайм reconcile (см. realtime/reconcile.ts).
 */
export async function finalizeTradeClose(
  tradeId: number,
  input: { closeReason: string; closePrice: number; resultR: number; resultPct: number },
): Promise<Trade | null> {
  const closedAt = new Date();
  const updated = await closeTradeIfActive(tradeId, { ...input, closedAt }).catch(() => null);
  if (!updated) {
    // Сделку уже закрыл другой путь (гонка ручного закрытия и авто-детекта) — статистику
    // риск-движка трогать повторно не нужно, она уже учтена тем, кто выиграл гонку.
    return null;
  }

  await recordTradeClose({
    closedAt,
    resultR: input.resultR,
    closeReason: input.closeReason,
    symbol: updated.symbol,
    rrPreset: updated.rrPreset,
  }).catch(() => {
    // не удалось обновить risk_state/лимиты — стоит проверить вручную через админку
  });
  stopTracking();
  eventBus.emitTyped("refresh", { reason: "trade.closed" });
  return updated;
}

const UNCLASSIFIED_CLOSE_REASONS = new Set(["external", "manual"]);

/**
 * Ручная атрибуция закрытия: админ помечает сделку без SL/TP (external/manual) как стоп
 * или тейк. resultR уже зафиксирован при закрытии — лестницу не трогаем повторно.
 * Дневные счётчики/локи пересобираем через resyncTradingDayRisk.
 */
export async function setTradeCloseReasonManual(
  tradeId: number,
  closeReason: "sl" | "tp",
): Promise<Trade> {
  const trade = await getTradeById(tradeId);
  if (!trade) {
    throw new TradeError("Сделка не найдена", 404);
  }
  if (trade.status !== "closed") {
    throw new TradeError("Можно менять причину только у закрытой сделки", 409);
  }
  if (!trade.closeReason || !UNCLASSIFIED_CLOSE_REASONS.has(trade.closeReason)) {
    throw new TradeError(
      "Причину можно задать только для сделок без SL/TP (закрытых на бирже или вручную)",
      409,
    );
  }
  if (trade.closeReason === closeReason) {
    return trade;
  }

  const updated = await updateTrade(tradeId, { closeReason });
  if (!updated) {
    throw new TradeError("Не удалось обновить сделку", 500);
  }

  await resyncTradingDayRisk().catch(() => {
    // инсайты уже увидят новый closeReason; локи можно добить кнопкой в админке
  });
  eventBus.emitTyped("refresh", { reason: "trade.reclassified" });
  return updated;
}

export async function listTradesNeedingCloseReason(): Promise<Trade[]> {
  return listUnclassifiedClosedTrades();
}

/**
 * После исполненной partial на ≈1/3: заменить SL на стоп по R/R 1/1 на остаток объёма
 * (лонг — стоп выше входа, шорт — ниже). Идемпотентно: если SL уже на стороне прибыли —
 * ничего не делает. Не бросает наружу при сбое биржи — возвращает warning (сделка жива).
 */
export async function moveStopLossToOneRAfterPartialOneToThree(
  tradeId: number,
): Promise<{ moved: boolean; warning: string | null }> {
  const trade = await getTradeById(tradeId);
  if (!trade || trade.status !== "active") {
    return { moved: false, warning: "активная сделка не найдена" };
  }

  const decision = decideMoveSlAfterPartialOneToThree({
    side: trade.side as TradeSide,
    entryPrice: Number(trade.entryPrice),
    slPrice: Number(trade.slPrice),
    partialTpPrice: trade.partialTpPrice !== null ? Number(trade.partialTpPrice) : null,
    partialTpFilledAt: trade.partialTpFilledAt,
    quantity: Number(trade.quantity),
    partialTpQuantity: trade.partialTpQuantity !== null ? Number(trade.partialTpQuantity) : null,
  });

  if (decision.action === "skip") {
    return { moved: false, warning: decision.reason };
  }

  const credentials = await getBingxCredentials();
  if (!credentials) {
    return { moved: false, warning: "нет ключей BingX — SL не подтянут" };
  }

  const orderIds = (trade.bingxOrderIds as Record<string, string | number> | null) ?? {};
  const exitSide: OrderSide = trade.side === "long" ? "SELL" : "BUY";
  const oldSlId = orderIds.sl;

  if (oldSlId !== undefined) {
    try {
      await cancelOrder(credentials, trade.symbol, oldSlId);
    } catch (error) {
      // Ордер мог уже исчезнуть после partial — пробуем всё равно выставить новый.
      console.warn(
        "[trades] не удалось отменить старый SL перед подтягиванием на 1/1:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  try {
    const slOrder = await placeOrder(credentials, {
      symbol: trade.symbol,
      side: exitSide,
      type: "STOP_MARKET",
      stopPrice: decision.newSlPrice,
      quantity: decision.remainderQuantity,
      reduceOnly: true,
    });

    const nextOrderIds = { ...orderIds, sl: slOrder.orderId };
    await updateTrade(trade.id, {
      slPrice: decision.newSlPrice,
      bingxOrderIds: nextOrderIds,
    });
    eventBus.emitTyped("refresh", { reason: "trade.slMovedAfterPartial" });
    return { moved: true, warning: null };
  } catch (error) {
    const message = bingxMessage(
      error,
      "Не удалось выставить SL на 1/1 после partial — проверьте стоп на BingX вручную",
    );
    console.error("[trades] moveStopLossToOneRAfterPartialOneToThree:", message);
    return { moved: false, warning: message };
  }
}

/**
 * Для уже открытой сделки: если partial на 1/3 уже исполнена, а SL ещё исходный —
 * подтянуть на 1/1. Вызывается при старте сервера (деплой) без поллинга.
 */
export async function repairActiveTradeSlAfterPartial(): Promise<{
  attempted: boolean;
  moved: boolean;
  warning: string | null;
}> {
  const trade = await getActiveTrade();
  if (!trade || !trade.partialTpFilledAt) {
    return { attempted: false, moved: false, warning: null };
  }
  const result = await moveStopLossToOneRAfterPartialOneToThree(trade.id);
  return { attempted: true, ...result };
}

/**
 * Ручное закрытие активной сделки: reduceOnly market-ордер, отмена оставшегося
 * SL/TP-ордера (иначе он останется висеть на бирже и может задеть будущую сделку
 * по тому же символу), запись результата и постфактум-фид в риск-движок.
 *
 * Реалтайм-детекция закрытия по SL/TP (см. realtime/reconcile.ts) обычно фиксирует
 * закрытие раньше, чем пользователь нажмёт эту кнопку. Но на случай задержки WS или
 * отключённого account-стрима — позиция может быть уже закрыта на бирже (сработал
 * стоп/тейк), а наша БД ещё считает сделку активной. Тогда не шлём повторный ордер
 * (биржа его отклонит, закрывать нечего), а фиксируем закрытие приближённо, чтобы
 * пользователь не оставался в дедлоке (не открыть новую сделку, не закрыть эту).
 */
export async function closeTrade(tradeId: number): Promise<Trade> {
  const trade = await getTradeById(tradeId);
  if (!trade || trade.status !== "active") {
    throw new TradeError("Активная сделка не найдена", 404);
  }

  const credentials = await getBingxCredentials();
  if (!credentials) {
    throw new TradeError("Ключи BingX не настроены");
  }

  const side = trade.side as TradeSide;
  const exitSide: OrderSide = side === "long" ? "SELL" : "BUY";
  const quantity = Number(trade.quantity);

  let closePrice: number;
  let closeReason = "manual";
  try {
    const positions = await getPositions(credentials, trade.symbol);
    const isStillOpen = positions.some((p) => Number(p.positionAmt) !== 0);

    if (isStillOpen) {
      const closeOrder = await placeOrder(credentials, {
        symbol: trade.symbol,
        side: exitSide,
        type: "MARKET",
        quantity,
        reduceOnly: true,
      });
      closePrice = closeOrder.avgPrice ? Number(closeOrder.avgPrice) : await getLatestPrice(trade.symbol);
    } else {
      // Позиции уже нет, но WS ещё не (или не смог) зафиксировать закрытие — берём
      // текущую рыночную цену как приближение для R/статистики.
      closePrice = await getLatestPrice(trade.symbol);
      closeReason = "external";
    }
  } catch (error) {
    throw new TradeError(bingxMessage(error, "Не удалось закрыть позицию на BingX"), 502);
  }

  // ВАЖНО: позиция уже закрыта на бирже с этого момента. Всё, что ниже, —
  // best-effort зачистка и запись результата; ошибки не должны вылетать необработанными.

  const orderIds = (trade.bingxOrderIds as Record<string, string | number> | null) ?? {};
  for (const key of ["sl", "tp", "partialTp"] as const) {
    const orderId = orderIds[key];
    if (orderId === undefined) continue;
    try {
      await cancelOrder(credentials, trade.symbol, orderId);
    } catch {
      // ордер мог уже исполниться/отмениться сам — ожидаемо, не критично
    }
  }

  const entryPrice = Number(trade.entryPrice);
  const riskUsd = Number(trade.riskUsd) || 0;
  const { resultR, resultPct } = computeResultFromPrices(side, entryPrice, closePrice, quantity, riskUsd);

  const updated = await finalizeTradeClose(tradeId, { closeReason, closePrice, resultR, resultPct });
  if (!updated) {
    // Проиграли гонку авто-детекту по WS — сделка уже закрыта, возвращаем актуальную запись.
    const settled = await getTradeById(tradeId);
    if (!settled) {
      throw new TradeError(
        "Позиция закрыта на бирже, но не удалось прочитать итоговую запись — проверьте историю",
        500,
      );
    }
    return settled;
  }
  return updated;
}

export type ActiveTradeView = Trade & {
  liquidationPrice: number | null;
  unrealizedProfit: number | null;
  /**
   * true, если по данным биржи позиции уже нет, хотя в БД сделка ещё "active" —
   * вероятно сработал SL/TP. Явная детекция и авто-закрытие — Этап 4; до этого
   * UI должен предложить подтвердить закрытие кнопкой (см. closeTrade).
   */
  positionFlat: boolean;
};

/** Активная сделка + живые данные позиции (ликвидация, PnL) для карточки на дашборде. */
export async function getActiveTradeView(): Promise<ActiveTradeView | null> {
  const trade = await getActiveTrade();
  if (!trade) {
    return null;
  }

  const credentials = await getBingxCredentials();
  if (!credentials) {
    return { ...trade, liquidationPrice: null, unrealizedProfit: null, positionFlat: false };
  }

  try {
    const positions = await getPositions(credentials, trade.symbol);
    const position = positions.find((p) => Number(p.positionAmt) !== 0);
    return {
      ...trade,
      liquidationPrice: position ? Number(position.liquidationPrice) : null,
      unrealizedProfit: position ? Number(position.unrealizedProfit) : null,
      positionFlat: !position,
    };
  } catch {
    return { ...trade, liquidationPrice: null, unrealizedProfit: null, positionFlat: false };
  }
}

export type ExternalPositionView = {
  symbol: string;
  side: TradeSide;
  quantity: number;
  entryPrice: number;
  leverage: number;
  liquidationPrice: number | null;
  unrealizedProfit: number | null;
};

/**
 * Позиции на BingX, открытые не через приложение (вручную на бирже) — у них нет
 * записи в trades, поэтому нет SL/TP/riskUsd, известных приложению, и риск-движок
 * ими не управляет. Показываем как есть, чтобы пользователь не остался в неведении,
 * и параллельно блокируем открытие новых сделок (см. checkCanOpenTrade), пока они
 * не закрыты. `excludeSymbol` — символ уже отслеживаемой в БД активной сделки, чтобы
 * не показать одну и ту же позицию дважды.
 */
export async function getExternalPositions(excludeSymbol?: string | null): Promise<ExternalPositionView[]> {
  const credentials = await getBingxCredentials();
  if (!credentials) {
    return [];
  }

  try {
    const positions = await getPositions(credentials);
    return positions
      .filter((p) => Number(p.positionAmt) !== 0 && p.symbol !== excludeSymbol)
      .map((p) => ({
        symbol: p.symbol,
        side: (Number(p.positionAmt) > 0 ? "long" : "short") as TradeSide,
        quantity: Math.abs(Number(p.positionAmt)),
        entryPrice: Number(p.avgPrice),
        leverage: Number(p.leverage),
        liquidationPrice: p.liquidationPrice ? Number(p.liquidationPrice) : null,
        unrealizedProfit: p.unrealizedProfit !== undefined ? Number(p.unrealizedProfit) : null,
      }));
  } catch {
    return [];
  }
}

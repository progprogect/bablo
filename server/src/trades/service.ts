import {
  cancelOrder,
  ensureOneWayMode,
  getContractLimits,
  getLatestPrice,
  getPositions,
  placeOrder,
  setLeverage,
  setMarginType,
  type BingXCredentials,
  type OrderSide,
} from "../bingx/client.js";
import { listActiveAssets, type Asset } from "../db/repositories/assets.js";
import { getBingxCredentials, getRiskSettings } from "../db/repositories/settings.js";
import {
  closeTradeIfActive,
  createTrade,
  getActiveTrade,
  getTradeById,
  listUnclassifiedClosedTrades,
  updateTrade,
  listClosedTrades,
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
  decideMoveSlAfterPartial,
  isValidPartialTakeProfit,
  isValidStopLoss,
  isValidTakeProfit,
  parseRRRatio,
  PARTIAL_TP_PERCENT,
  RR_PRESETS,
  requiresPartialTakeProfit,
  computeRiskRewardRatio,
  isPartialTakeProfitWithinMaxRatio,
  type TradeSide,
} from "./math.js";
// filledOrder не зависит от trades/ — статический импорт не создаёт цикл
// (в отличие от realtime/reconcile.ts, который импортирует finalizeTradeClose отсюда).
import {
  findFilledSlOrTp,
  listExchangeClosingFills,
  resolveCloseFromFilledOrder,
} from "../realtime/filledOrder.js";
import { decideNightTakeProfit } from "./nightTp.js";
import {
  computeResult,
  computeResultFromExchangeFills,
  resolveRecalculateClosePrice,
  resultFromManualPnl,
  shouldTrustExchangeResult,
} from "./result.js";
import {
  resolveAutoMonthlyRrPresetBucket,
  STATS_RR_PRESET_NONE,
  type MonthlyStatTradeInput,
} from "../history/monthlyStats.js";
import {
  isManualOutcome,
  resolveStatsResultR,
  resolveTradeOutcome,
  type TradeForOutcome,
  type TradeOutcome,
} from "../history/outcome.js";

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
 *
 * Перед записью итог СВЕРЯЕТСЯ С БИРЖЕЙ (best-effort): суммируем PnL реальных
 * закрывающих исполнений из истории ордеров BingX. Это единственный способ учесть
 * ордера, изменённые пользователем прямо на бирже (у них другой orderId — приложение
 * их fill'ы не видит), из-за которых расчёт по сохранённым планам расходился с фактом.
 * `realizedProfit` финального ордера нужен на случай, когда история BingX ещё не
 * содержит только что исполнившееся закрытие (известный лаг).
 */
export async function finalizeTradeClose(
  tradeId: number,
  input: {
    closeReason: string;
    closePrice: number;
    resultR: number;
    resultPct: number;
    realizedProfit?: number | null;
  },
): Promise<Trade | null> {
  let { resultR, resultPct } = input;
  try {
    const credentials = await getBingxCredentials();
    const trade = credentials ? await getTradeById(tradeId) : null;
    if (credentials && trade && trade.status === "active") {
      const fills = await listExchangeClosingFills(credentials, trade);
      if (fills !== null) {
        const fromExchange = computeResultFromExchangeFills(trade, fills, {
          closePrice: input.closePrice,
          realizedProfit: input.realizedProfit ?? null,
        });
        if (fromExchange && shouldTrustExchangeResult(fromExchange.resultR, resultR)) {
          if (Math.abs(fromExchange.resultR - resultR) > 0.01) {
            console.info(
              `[trades] итог по бирже отличается от расчётного: ${resultR.toFixed(4)}R → ${fromExchange.resultR.toFixed(4)}R (${trade.symbol})`,
            );
          }
          resultR = fromExchange.resultR;
          resultPct = fromExchange.resultPct;
        }
      }
    }
  } catch (error) {
    // Сверка best-effort: без неё работает прежний расчёт, закрытие не блокируем.
    console.warn("[trades] сверка итога с биржей не удалась:", error);
  }

  const closedAt = new Date();
  const updated = await closeTradeIfActive(tradeId, {
    closedAt,
    closeReason: input.closeReason,
    closePrice: input.closePrice,
    resultR,
    resultPct,
  }).catch(() => null);
  if (!updated) {
    // Сделку уже закрыл другой путь (гонка ручного закрытия и авто-детекта) — статистику
    // риск-движка трогать повторно не нужно, она уже учтена тем, кто выиграл гонку.
    return null;
  }

  await recordTradeClose({
    closedAt,
    resultR,
    closeReason: input.closeReason,
    symbol: updated.symbol,
    rrPreset: updated.rrPreset,
    entryPrice: updated.entryPrice !== null ? Number(updated.entryPrice) : null,
    slPrice: updated.slPrice !== null ? Number(updated.slPrice) : null,
    side: updated.side,
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

/** Поля строки сделки, по которым считается исход (history/outcome.ts). */
function toOutcomeInput(trade: Trade): TradeForOutcome {
  return {
    closeReason: trade.closeReason,
    entryPrice: trade.entryPrice !== null ? Number(trade.entryPrice) : null,
    slPrice: trade.slPrice !== null ? Number(trade.slPrice) : null,
    side: trade.side,
    statsOutcome: trade.statsOutcome,
  };
}

function toMonthlyInput(trade: Trade): MonthlyStatTradeInput {
  return {
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    closeReason: trade.closeReason,
    resultR: trade.resultR !== null ? Number(trade.resultR) : null,
    riskUsd: trade.riskUsd !== null ? Number(trade.riskUsd) : null,
    rrPreset: trade.rrPreset,
    entryPrice: trade.entryPrice !== null ? Number(trade.entryPrice) : null,
    quantity: Number(trade.quantity),
    partialTpPrice: trade.partialTpPrice !== null ? Number(trade.partialTpPrice) : null,
    partialTpFilledAt: trade.partialTpFilledAt,
    nightTpAppliedAt: trade.nightTpAppliedAt,
    statsRrPreset: trade.statsRrPreset,
    slPrice: trade.slPrice !== null ? Number(trade.slPrice) : null,
    side: trade.side,
    statsOutcome: trade.statsOutcome,
  };
}

export type StatsRrAdminTrade = Trade & {
  /** Что поставило бы авто-правило без оверрайда. */
  autoStatsRrPreset: string | null;
  /** Что реально пойдёт в сетку статистики сейчас. */
  effectiveStatsRrPreset: string | null;
  /** Исход, который определило бы авто-правило (без ручного statsOutcome). */
  autoOutcome: TradeOutcome;
  /** Исход, который сейчас реально идёт во всю статистику. */
  effectiveOutcome: TradeOutcome;
  /** R, который сейчас идёт в суммы статистики (с учётом ручного столбца R). */
  effectiveStatsResultR: number | null;
};

/** Закрытые сделки для админки: правка столбца R в месячной статистике. */
export async function listTradesForStatsRrAdmin(options: {
  limit: number;
  offset: number;
}): Promise<{ trades: StatsRrAdminTrade[]; total: number }> {
  const page = await listClosedTrades(options);
  const trades = page.trades.map((trade) => {
    const input = toMonthlyInput(trade);
    const autoStatsRrPreset = resolveAutoMonthlyRrPresetBucket(input);
    const effectiveStatsRrPreset =
      trade.statsRrPreset != null
        ? trade.statsRrPreset === STATS_RR_PRESET_NONE || trade.statsRrPreset === ""
          ? null
          : trade.statsRrPreset
        : autoStatsRrPreset;
    const resultR = trade.resultR !== null ? Number(trade.resultR) : 0;
    const autoOutcome = resolveTradeOutcome({ ...toOutcomeInput(trade), statsOutcome: null }, resultR);
    const effectiveOutcome = resolveTradeOutcome(toOutcomeInput(trade), resultR);
    const effectiveStatsResultR = resolveStatsResultR(
      { statsRrPreset: trade.statsRrPreset, resultR: trade.resultR !== null ? resultR : null },
      effectiveOutcome,
    );
    return {
      ...trade,
      autoStatsRrPreset,
      effectiveStatsRrPreset,
      autoOutcome,
      effectiveOutcome,
      effectiveStatsResultR,
    };
  });
  return { trades, total: page.total };
}

/**
 * Ручная корректировка столбца R в месячной статистике.
 * null — снова авто; "none" — не учитывать в сетке; иначе пресет RR_PRESETS.
 * На карточку сделки в Истории (rrPreset) не влияет.
 */
export async function setTradeStatsRrPreset(
  tradeId: number,
  statsRrPreset: string | null,
): Promise<Trade> {
  const trade = await getTradeById(tradeId);
  if (!trade) {
    throw new TradeError("Сделка не найдена", 404);
  }
  if (trade.status !== "closed") {
    throw new TradeError("Корректировать R статистики можно только у закрытой сделки", 409);
  }

  let normalized: string | null = statsRrPreset;
  if (normalized === "") normalized = null;
  if (normalized !== null && normalized !== STATS_RR_PRESET_NONE) {
    if (!(RR_PRESETS as readonly string[]).includes(normalized)) {
      throw new TradeError("Некорректный пресет R для статистики");
    }
  }

  const updated = await updateTrade(tradeId, { statsRrPreset: normalized });
  if (!updated) {
    throw new TradeError("Не удалось обновить сделку", 500);
  }
  eventBus.emitTyped("refresh", { reason: "trade.statsRrPreset" });
  return updated;
}

/**
 * Ручная корректировка ИСХОДА закрытой сделки для статистики: "tp" | "sl" | "be",
 * либо null — вернуться к авто-определению (history/outcome.ts).
 *
 * Работает для ЛЮБОЙ закрытой сделки, в том числе уже классифицированной биржей: это
 * отдельный слой поверх факта, `closeReason` не затирается — пересчёт результата и
 * сверки с BingX продолжают видеть реальную причину закрытия.
 *
 * Влияет сразу на всё: месячную разбивку TP/SL/БУ, сетку R, инсайты, подпись в истории
 * и дневные лимиты. Для лимитов текущего дня пересобираем счётчики сразу — иначе правка
 * доехала бы до блокировок только при следующем закрытии сделки или рестарте.
 */
export async function setTradeStatsOutcome(tradeId: number, statsOutcome: string | null): Promise<Trade> {
  const trade = await getTradeById(tradeId);
  if (!trade) {
    throw new TradeError("Сделка не найдена", 404);
  }
  if (trade.status !== "closed") {
    throw new TradeError("Корректировать исход можно только у закрытой сделки", 409);
  }

  let normalized: string | null = statsOutcome;
  if (normalized === "" || normalized === "auto") normalized = null;
  if (normalized !== null && !isManualOutcome(normalized)) {
    throw new TradeError("Исход должен быть 'tp', 'sl', 'be' или null (авто)");
  }

  const updated = await updateTrade(tradeId, { statsOutcome: normalized });
  if (!updated) {
    throw new TradeError("Не удалось обновить сделку", 500);
  }

  await resyncTradingDayRisk().catch(() => {
    // Счётчики дня можно добить кнопкой «Пересчитать дневные лимиты» в админке.
  });
  eventBus.emitTyped("refresh", { reason: "trade.statsOutcome" });
  return updated;
}

/**
 * Ручная правка ИТОГОВОЙ СУММЫ закрытой сделки (админка): пользователь вводит PnL в USDT,
 * из него пересчитываются resultR/resultPct — та же запись, которую делает авто-расчёт
 * или «Пересчитать», только числом от пользователя. Отдельного слоя-оверрайда нет
 * осознанно: сумма — это факт сделки, от него считаются деньги, R, % к депозиту и
 * дневные лимиты; слой поверх пришлось бы протаскивать во все эти места. «Отменить»
 * можно кнопкой «Пересчитать» — она вернёт цифру с биржи, пока BingX хранит историю.
 */
export async function setTradeResultManual(tradeId: number, pnlUsd: number): Promise<Trade> {
  const trade = await getTradeById(tradeId);
  if (!trade) {
    throw new TradeError("Сделка не найдена", 404);
  }
  if (trade.status !== "closed") {
    throw new TradeError("Задавать сумму можно только у закрытой сделки", 409);
  }
  if (!Number.isFinite(pnlUsd) || Math.abs(pnlUsd) > 1_000_000) {
    throw new TradeError("Некорректная сумма");
  }

  const computed = resultFromManualPnl(trade, pnlUsd);
  if (!computed) {
    throw new TradeError("У сделки не записан риск (riskUsd) — R из суммы не посчитать", 409);
  }

  const updated = await updateTrade(tradeId, computed);
  if (!updated) {
    throw new TradeError("Не удалось обновить сделку", 500);
  }

  await resyncTradingDayRisk().catch(() => {
    // Счётчики дня можно добить кнопкой «Пересчитать дневные лимиты» в админке.
  });
  eventBus.emitTyped("refresh", { reason: "trade.resultManual" });
  return updated;
}

/**
 * Пересчитать resultR/resultPct закрытой сделки.
 * Источник цены: fill BingX → closePrice → slPrice (для SL с «нулевым» close≈entry).
 * Нужно, когда BingX отдал rp=0 / ap≈entry при проскальзывании и в истории зависло 0 USDT.
 * Лестницу уровней не трогаем повторно; дневные лимиты — через resync.
 */
/** Диагностика сверки с биржей — чтобы в админке было видно, ЧТО нашлось в истории BingX. */
export type RecalculateExchangeInfo = {
  /** Сколько закрывающих FILLED-исполнений найдено в истории (без ордера входа). */
  fills: number;
  /** Какой объём сделки покрыт этими исполнениями. */
  coveredQty: number;
  quantity: number;
  /** Итоговый PnL по сверке (исполнения + добивка остатка по цене закрытия). */
  pnlUsd: number;
  resultR: number;
  /** Использован ли итог биржи для записи. */
  used: boolean;
  /** Почему не использован (история недоступна / пусто / похоже на баг rp=0). */
  reason: string | null;
};

export type RecalculateTradeResultResponse = {
  trade: Trade;
  source: "bingx" | "stored" | "sl";
  beforeR: number | null;
  afterR: number | null;
  changed: boolean;
  exchange: RecalculateExchangeInfo | null;
};

export async function recalculateTradeResult(
  tradeId: number,
): Promise<RecalculateTradeResultResponse> {
  const trade = await getTradeById(tradeId);
  if (!trade) {
    throw new TradeError("Сделка не найдена", 404);
  }
  if (trade.status !== "closed") {
    throw new TradeError("Пересчитывать можно только закрытую сделку", 409);
  }

  const beforeR = trade.resultR !== null ? Number(trade.resultR) : null;
  const credentials = await getBingxCredentials().catch(() => null);

  let bingxFillPrice: number | null = null;
  const orderIds = (trade.bingxOrderIds ?? {}) as Record<string, string | number>;
  if (credentials && (orderIds.sl !== undefined || orderIds.tp !== undefined)) {
    try {
      const fill = await findFilledSlOrTp(credentials, trade, orderIds);
      const raw = fill?.order.avgPrice != null ? Number(fill.order.avgPrice) : NaN;
      if (Number.isFinite(raw) && raw > 0) {
        bingxFillPrice = raw;
      }
    } catch (error) {
      console.warn("[trades] recalculate: BingX fill lookup failed", error);
    }
  }

  const resolved = resolveRecalculateClosePrice({
    side: trade.side as TradeSide,
    entryPrice: Number(trade.entryPrice),
    quantity: Number(trade.quantity),
    riskUsd: Number(trade.riskUsd) || 0,
    slPrice: trade.slPrice != null ? Number(trade.slPrice) : null,
    closePrice: trade.closePrice != null ? Number(trade.closePrice) : null,
    closeReason: trade.closeReason,
    partialTpFilledAt: trade.partialTpFilledAt,
    bingxFillPrice,
  });

  if (!resolved) {
    throw new TradeError("Нет цены закрытия (ни fill BingX, ни closePrice, ни SL)", 409);
  }

  let { resultR, resultPct } = computeResult(trade, resolved.closePrice, null);
  let source = resolved.source;
  let exchange: RecalculateExchangeInfo | null = null;

  // Главный источник — сумма PnL реальных закрывающих исполнений с BingX: она видит
  // и ордера, изменённые вручную на бирже (другие orderId), про которые приложение не
  // знает. Пока биржа хранит историю (7 дней) — этим и чинится «своя цифра» в записи.
  if (credentials) {
    try {
      const fills = await listExchangeClosingFills(credentials, trade);
      const quantity = Number(trade.quantity) || 0;
      const riskUsd = Number(trade.riskUsd) || 0;
      if (fills === null) {
        exchange = {
          fills: 0,
          coveredQty: 0,
          quantity,
          pnlUsd: 0,
          resultR: 0,
          used: false,
          reason: "история ордеров BingX недоступна (хранится 7 дней) или у сделки нет id входа",
        };
      } else {
        const coveredQty = fills.reduce(
          (sum, f) => sum + (Number.isFinite(f.executedQty) && f.executedQty > 0 ? f.executedQty : 0),
          0,
        );
        const fromExchange =
          fills.length > 0
            ? computeResultFromExchangeFills(trade, fills, {
                closePrice: resolved.closePrice,
                realizedProfit: null,
              })
            : null;
        if (fills.length === 0) {
          exchange = {
            fills: 0,
            coveredQty: 0,
            quantity,
            pnlUsd: 0,
            resultR: 0,
            used: false,
            reason: "закрывающих исполнений в истории BingX не найдено",
          };
        } else if (fromExchange && shouldTrustExchangeResult(fromExchange.resultR, resultR)) {
          resultR = fromExchange.resultR;
          resultPct = fromExchange.resultPct;
          source = "bingx";
          exchange = {
            fills: fills.length,
            coveredQty,
            quantity,
            pnlUsd: fromExchange.resultR * riskUsd,
            resultR: fromExchange.resultR,
            used: true,
            reason: null,
          };
        } else {
          exchange = {
            fills: fills.length,
            coveredQty,
            quantity,
            pnlUsd: (fromExchange?.resultR ?? 0) * riskUsd,
            resultR: fromExchange?.resultR ?? 0,
            used: false,
            reason:
              fromExchange === null
                ? "не хватает данных сделки для расчёта (вход/объём)"
                : "PnL биржи ≈ 0 при материальном расчётном R — похоже на баг rp=0, оставлен расчёт по ценам",
          };
        }
      }
    } catch (error) {
      console.warn("[trades] recalculate: сверка по исполнениям BingX не удалась", error);
    }
  }

  const afterR = resultR;
  const changed =
    beforeR === null ||
    !Number.isFinite(beforeR) ||
    Math.abs(beforeR - afterR) > 1e-6 ||
    trade.closePrice === null ||
    Math.abs(Number(trade.closePrice) - resolved.closePrice) > 1e-12;

  const updated = await updateTrade(tradeId, {
    resultR,
    resultPct,
    closePrice: resolved.closePrice,
  });
  if (!updated) {
    throw new TradeError("Не удалось обновить сделку", 500);
  }

  await resyncTradingDayRisk().catch(() => {
    // результат уже в БД; дневные локи можно добить кнопкой в админке
  });
  eventBus.emitTyped("refresh", { reason: "trade.resultRecalculated" });
  return {
    trade: updated,
    source,
    beforeR,
    afterR,
    changed,
    exchange,
  };
}

/**
 * После исполненной partial на ≈1/2 или ≈1/3: заменить SL так, чтобы остаток
 * имел ход не больше 2R (1/2 → вход, 1/3 → R/R 1/1). Идемпотентно: если SL уже
 * на стороне прибыли — ничего не делает. Не бросает наружу при сбое биржи —
 * возвращает warning (сделка жива).
 */
export async function moveStopLossAfterPartial(
  tradeId: number,
): Promise<{ moved: boolean; warning: string | null }> {
  const trade = await getTradeById(tradeId);
  if (!trade || trade.status !== "active") {
    return { moved: false, warning: "активная сделка не найдена" };
  }

  const decision = decideMoveSlAfterPartial({
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
  const targetLabel =
    decision.slRatio <= 0 ? "вход (безубыток)" : `R/R 1/${decision.slRatio}`;

  const moved = await replaceConditionalOrder(credentials, {
    symbol: trade.symbol,
    exitSide,
    type: "STOP_MARKET",
    oldOrderId: orderIds.sl,
    oldStopPrice: trade.slPrice !== null ? Number(trade.slPrice) : null,
    newStopPrice: decision.newSlPrice,
    quantity: decision.remainderQuantity,
    failureMessage: `Не удалось выставить SL на ${targetLabel} после partial — проверьте стоп на BingX вручную`,
  });

  if (!moved.ok) {
    // Прежний стоп возвращён на место (новый id) — записываем, иначе в БД останется
    // мёртвый ордер и закрытие по стопу не определится.
    if (moved.restoredOrderId !== null) {
      await updateTrade(trade.id, {
        bingxOrderIds: { ...orderIds, sl: moved.restoredOrderId },
      }).catch(() => {});
    }
    return { moved: false, warning: moved.message };
  }

  await updateTrade(trade.id, {
    slPrice: decision.newSlPrice,
    bingxOrderIds: { ...orderIds, sl: moved.orderId },
  });
  eventBus.emitTyped("refresh", { reason: "trade.slMovedAfterPartial" });
  return { moved: true, warning: null };
}

/** @deprecated Алиас moveStopLossAfterPartial. */
export async function moveStopLossToOneRAfterPartialOneToThree(
  tradeId: number,
): Promise<{ moved: boolean; warning: string | null }> {
  return moveStopLossAfterPartial(tradeId);
}

/**
 * Для уже открытой сделки: если partial на 1/2 или 1/3 уже исполнена, а SL ещё
 * исходный — подтянуть по правилу 2R. Вызывается при старте сервера (деплой)
 * без поллинга.
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
  const result = await moveStopLossAfterPartial(trade.id);
  return { attempted: true, ...result };
}

export type ReplaceConditionalOrderResult =
  | { ok: true; orderId: string | number }
  | { ok: false; message: string; restoredOrderId: string | number | null };

/**
 * Заменяет условный ордер (SL или TP) на бирже: отменяет старый, ставит новый и, если
 * новый выставить не удалось, ВОЗВРАЩАЕТ СТАРЫЙ на место.
 *
 * Без отката позиция оставалась бы вообще без стопа или без тейка: старый ордер уже
 * отменён, новый не встал, а в БД по-прежнему лежит id мёртвого ордера — по нему потом
 * не определится и причина закрытия. Восстановленный ордер получает новый id, поэтому
 * вызывающая сторона обязана сохранить `restoredOrderId` в bingxOrderIds.
 */
async function replaceConditionalOrder(
  credentials: BingXCredentials,
  input: {
    symbol: string;
    exitSide: OrderSide;
    type: "STOP_MARKET" | "TAKE_PROFIT_MARKET";
    oldOrderId: string | number | undefined;
    /** Цена старого ордера — нужна, чтобы вернуть его при сбое. null — восстанавливать нечего. */
    oldStopPrice: number | null;
    newStopPrice: number;
    quantity: number;
    failureMessage: string;
  },
): Promise<ReplaceConditionalOrderResult> {
  if (input.oldOrderId !== undefined) {
    try {
      await cancelOrder(credentials, input.symbol, input.oldOrderId);
    } catch (error) {
      // Ордер мог уже исполниться/исчезнуть — пробуем выставить новый в любом случае.
      console.warn(
        `[trades] не удалось отменить старый ${input.type}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  const place = (stopPrice: number) =>
    placeOrder(credentials, {
      symbol: input.symbol,
      side: input.exitSide,
      type: input.type,
      stopPrice,
      quantity: input.quantity,
      reduceOnly: true,
    });

  try {
    const order = await place(input.newStopPrice);
    return { ok: true, orderId: order.orderId };
  } catch (error) {
    const message = bingxMessage(error, input.failureMessage);
    console.error(`[trades] ${input.type} не выставлен:`, message);

    if (input.oldStopPrice === null || !(input.oldStopPrice > 0)) {
      return { ok: false, message, restoredOrderId: null };
    }
    try {
      const restored = await place(input.oldStopPrice);
      console.warn(`[trades] вернул прежний ${input.type} на ${input.oldStopPrice}`);
      return { ok: false, message, restoredOrderId: restored.orderId };
    } catch (restoreError) {
      console.error(
        `[trades] прежний ${input.type} восстановить не удалось:`,
        restoreError instanceof Error ? restoreError.message : restoreError,
      );
      return { ok: false, message, restoredOrderId: null };
    }
  }
}

/**
 * Ночное правило для дневной сделки, активной после 01:00 МСК (docs/PROJECT.md).
 * Развилка по текущей цене:
 * - цена ещё не дошла до 1/1 → TP переносится на 1/1 × 100% остатка, незаполненный
 *   partial отменяется (не пересиживаем ночь ради дальней цели);
 * - цена уже прошла 1/1 → TP остаётся плановым, а SL подтягивается на 1/1, чтобы
 *   сделка не могла закончиться хуже +1R.
 *
 * Идемпотентно (nightTpAppliedAt). Не бросает наружу при сбое биржи — warning.
 */
export async function applyNightTakeProfitForActiveTrade(
  now: Date = new Date(),
): Promise<{ attempted: boolean; applied: boolean; warning: string | null }> {
  const trade = await getActiveTrade();
  if (!trade) {
    return { attempted: false, applied: false, warning: null };
  }

  const settings = await getRiskSettings();
  // Цена нужна, чтобы отличить «до 1/1 ещё не дошли» от «уже прошли». Best-effort:
  // без неё решение сваливается на прежнюю ветку (перенос TP), а не блокируется.
  const currentPrice = await getLatestPrice(trade.symbol).catch(() => null);
  const decision = decideNightTakeProfit({
    side: trade.side as TradeSide,
    entryPrice: Number(trade.entryPrice),
    slPrice: Number(trade.slPrice),
    riskUsd: Number(trade.riskUsd),
    quantity: Number(trade.quantity),
    tpPrice: trade.tpPrice !== null ? Number(trade.tpPrice) : null,
    currentPrice,
    partialTpPrice: trade.partialTpPrice !== null ? Number(trade.partialTpPrice) : null,
    partialTpQuantity: trade.partialTpQuantity !== null ? Number(trade.partialTpQuantity) : null,
    partialTpFilledAt: trade.partialTpFilledAt,
    nightTpAppliedAt: trade.nightTpAppliedAt,
    openedAt: trade.openedAt,
    now,
    resetHour: settings.resetHour,
    tzOffsetMinutes: settings.tzOffsetMinutes,
  });

  if (decision.action === "skip") {
    return { attempted: true, applied: false, warning: decision.reason };
  }

  const credentials = await getBingxCredentials();
  if (!credentials) {
    return { attempted: true, applied: false, warning: "нет ключей BingX — ночное правило не применено" };
  }

  const orderIds = (trade.bingxOrderIds as Record<string, string | number> | null) ?? {};
  const exitSide: OrderSide = trade.side === "long" ? "SELL" : "BUY";

  // Цена уже прошла 1/1: тейк не трогаем, подтягиваем стоп на 1/1.
  if (decision.action === "moveSl") {
    const moved = await replaceConditionalOrder(credentials, {
      symbol: trade.symbol,
      exitSide,
      type: "STOP_MARKET",
      oldOrderId: orderIds.sl,
      oldStopPrice: trade.slPrice !== null ? Number(trade.slPrice) : null,
      newStopPrice: decision.newSlPrice,
      quantity: decision.quantity,
      failureMessage: "Не удалось подтянуть SL на 1/1 на ночь — проверьте стоп на BingX вручную",
    });

    if (!moved.ok) {
      // Стоп остался прежним (или восстановлен новым ордером) — сохраняем актуальный id,
      // иначе в БД останется мёртвый, и закрытие по стопу не определится.
      if (moved.restoredOrderId !== null) {
        await updateTrade(trade.id, {
          bingxOrderIds: { ...orderIds, sl: moved.restoredOrderId },
        }).catch(() => {});
      }
      return { attempted: true, applied: false, warning: moved.message };
    }

    await updateTrade(trade.id, {
      slPrice: decision.newSlPrice,
      nightTpAppliedAt: now,
      bingxOrderIds: { ...orderIds, sl: moved.orderId },
    });
    eventBus.emitTyped("refresh", { reason: "trade.nightSlMoved" });
    return { attempted: true, applied: true, warning: null };
  }

  // Цена до 1/1 не дошла: переносим тейк на 1/1 × 100% остатка.
  const replaced = await replaceConditionalOrder(credentials, {
    symbol: trade.symbol,
    exitSide,
    type: "TAKE_PROFIT_MARKET",
    oldOrderId: orderIds.tp,
    oldStopPrice: trade.tpPrice !== null ? Number(trade.tpPrice) : null,
    newStopPrice: decision.newTpPrice,
    quantity: decision.quantity,
    failureMessage: "Не удалось выставить ночной TP 1/1 — проверьте тейк на BingX вручную",
  });

  if (!replaced.ok) {
    if (replaced.restoredOrderId !== null) {
      await updateTrade(trade.id, {
        bingxOrderIds: { ...orderIds, tp: replaced.restoredOrderId },
      }).catch(() => {});
    }
    return { attempted: true, applied: false, warning: replaced.message };
  }

  // Partial гасим только теперь, когда новый TP уже стоит: при сбое выше план сделки
  // остаётся нетронутым целиком, а не наполовину разобранным.
  const nextOrderIds: Record<string, string | number> = { ...orderIds, tp: replaced.orderId };
  if (decision.cancelPartial && orderIds.partialTp !== undefined) {
    try {
      await cancelOrder(credentials, trade.symbol, orderIds.partialTp);
    } catch (error) {
      console.warn(
        "[trades] не удалось отменить partial перед ночным TP 1/1:",
        error instanceof Error ? error.message : error,
      );
    }
    delete nextOrderIds.partialTp;
  }

  await updateTrade(trade.id, {
    tpPrice: decision.newTpPrice,
    rrPreset: "1/1",
    nightTpAppliedAt: now,
    bingxOrderIds: nextOrderIds,
    ...(decision.cancelPartial
      ? {
          partialTpPrice: null,
          partialTpPercent: null,
          partialTpQuantity: null,
        }
      : {}),
  });
  eventBus.emitTyped("refresh", { reason: "trade.nightTpApplied" });
  return { attempted: true, applied: true, warning: null };
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

  const orderIdsForLookup = (trade.bingxOrderIds as Record<string, string | number> | null) ?? {};

  let closePrice: number;
  let closeReason = "manual";
  let realizedProfit: number | null = null;
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
      // Позиции уже нет: сработал наш SL/TP, а событие WS не дошло (рестарт/деплой,
      // обрыв стрима). Раньше это безусловно писалось как "external" — сделка, реально
      // закрытая по тейку (в т.ч. ночному 1/1), не попадала ни в тейки статистики, ни в
      // дневные лимиты. Сначала спрашиваем биржу, какой из ордеров исполнился.
      const filled = await findFilledSlOrTp(credentials, trade, orderIdsForLookup).catch(() => null);
      if (filled) {
        const resolved = resolveCloseFromFilledOrder(trade, filled);
        closeReason = resolved.closeReason;
        closePrice = resolved.closePrice;
        realizedProfit = resolved.realizedProfit;
      } else {
        // Ни один наш ордер не исполнился — позицию действительно закрыли мимо приложения.
        closePrice = await getLatestPrice(trade.symbol);
        closeReason = "external";
      }
    }
  } catch (error) {
    throw new TradeError(bingxMessage(error, "Не удалось закрыть позицию на BingX"), 502);
  }

  // ВАЖНО: позиция уже закрыта на бирже с этого момента. Всё, что ниже, —
  // best-effort зачистка и запись результата; ошибки не должны вылетать необработанными.

  for (const key of ["sl", "tp", "partialTp"] as const) {
    const orderId = orderIdsForLookup[key];
    if (orderId === undefined) continue;
    try {
      await cancelOrder(credentials, trade.symbol, orderId);
    } catch {
      // ордер мог уже исполниться/отмениться сам — ожидаемо, не критично
    }
  }

  // computeResult (а не computeResultFromPrices) — учитывает уже исполненную частичную
  // фиксацию и realizedProfit исполнившегося ордера, как и авто-детект по WS. Иначе у
  // сделки с partial ручное закрытие давало R только по остатку.
  const { resultR, resultPct } = computeResult(trade, closePrice, realizedProfit);

  const updated = await finalizeTradeClose(tradeId, {
    closeReason,
    closePrice,
    resultR,
    resultPct,
    realizedProfit,
  });
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

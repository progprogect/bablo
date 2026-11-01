import { computeRiskUsd, computeResultFromPrices, type TradeSide } from "../trades/math.js";
import { getLocalHour } from "../risk/tradingDay.js";
import { resolveTradeOutcome } from "./outcome.js";

/**
 * Восстановление истории сделок из журнала ордеров BingX (01.11.2026).
 *
 * Понадобилось после блокировки аккаунта Railway: база с историей осталась недоступна, а
 * приложение переехало на пустую. Биржа при этом помнит свои ордера — из них можно
 * собрать закрытые сделки заново: вход, стоп, выход, объём, реальный PnL и, если стоп
 * известен, результат в R.
 *
 * Чего в журнале биржи НЕТ и что восстановлено не будет: пресет R/R, с которым входили
 * (`rrPreset`), ручные пометки исхода, привязка выводов к уровням, частичная фиксация как
 * отдельная сущность. Поэтому импортированная сделка — это факт денег, а не план сделки.
 *
 * Здесь только чистая логика без I/O (как limits.ts): ордера приходят параметром,
 * запросы к бирже и запись в БД — в bingxImportService.ts.
 *
 * ВАЖНО про условные ордера. Когда у BingX срабатывает STOP_MARKET или
 * TAKE_PROFIT_MARKET, исходный ордер остаётся CANCELLED навсегда, а биржа создаёт НОВЫЙ
 * market-ордер с другим orderId, у которого `triggerOrderId` указывает на исходный
 * (найдено эмпирически 16.07.2026, см. bingx/client.ts). Поэтому причину закрытия ищем
 * по цепочке triggerOrderId → тип исходного ордера, а не по типу самого исполнения.
 */

/** Ордер BingX в том виде, в каком он нужен сборке. Поля — как отдаёт `allOrders`. */
export type ImportOrder = {
  orderId: string;
  symbol: string;
  /** BUY | SELL */
  side: string;
  /** MARKET | LIMIT | STOP_MARKET | TAKE_PROFIT_MARKET | … */
  type: string;
  status: string;
  /** Средняя цена исполнения; у неисполненных — 0. */
  avgPrice: number;
  executedQty: number;
  /** Цена срабатывания условного ордера — она же цена стопа для расчёта риска. */
  stopPrice: number | null;
  /** Реализованный PnL этого исполнения (поле profit у BingX). */
  profit: number | null;
  /** Время создания и обновления, мс. */
  time: number;
  updateTime: number | null;
  /** Исходный условный ордер, срабатывание которого создало это исполнение. */
  triggerOrderId: string | null;
};

/** Собранная сделка — то, что пойдёт в таблицу trades. */
export type ImportedTrade = {
  symbol: string;
  side: TradeSide;
  quantity: number;
  entryPrice: number;
  closePrice: number;
  /** Цена стопа, если условный ордер нашёлся; null — риск и R посчитать не из чего. */
  slPrice: number | null;
  openedAt: Date;
  closedAt: Date;
  /** "sl" | "tp" — сработал условный ордер; "manual" — закрыто иначе. */
  closeReason: "sl" | "tp" | "manual";
  riskUsd: number | null;
  resultR: number | null;
  resultPct: number | null;
  realizedPnlUsd: number;
  /** Идентификаторы ордеров биржи: по ним импорт не задваивает уже загруженное. */
  orderIds: { entry: string[]; exit: string[] };
};

/** Почему ордер (или их группа) не превратился в сделку — показываем в предпросмотре. */
export type ImportSkip = {
  symbol: string;
  reason: string;
  orderIds: string[];
};

export type ImportBuildResult = {
  trades: ImportedTrade[];
  skipped: ImportSkip[];
};

/** Нормализация: BingX отдаёт числа строками, а часть полей может отсутствовать. */
export function toImportOrder(raw: Record<string, unknown>): ImportOrder | null {
  const orderId = raw.orderId ?? raw.orderID;
  const symbol = raw.symbol;
  if (orderId === undefined || typeof symbol !== "string") return null;
  const num = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const optionalNum = (value: unknown): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const time = num(raw.time ?? raw.updateTime);
  return {
    orderId: String(orderId),
    symbol,
    side: String(raw.side ?? ""),
    type: String(raw.type ?? ""),
    status: String(raw.status ?? ""),
    avgPrice: num(raw.avgPrice ?? raw.averagePrice ?? raw.price),
    executedQty: num(raw.executedQty ?? raw.origQty ?? raw.quantity),
    stopPrice: optionalNum(raw.stopPrice ?? raw.triggerPrice),
    profit: optionalNum(raw.profit ?? raw.realizedPnl),
    time,
    updateTime: optionalNum(raw.updateTime),
    triggerOrderId:
      raw.triggerOrderId !== undefined && raw.triggerOrderId !== null && String(raw.triggerOrderId) !== "0"
        ? String(raw.triggerOrderId)
        : null,
  };
}

const FILLED_STATUSES = new Set(["FILLED", "PARTIALLY_FILLED"]);

/** Момент исполнения: у условных ордеров он в updateTime, у обычных совпадает с time. */
function filledAt(order: ImportOrder): number {
  return order.updateTime && order.updateTime > 0 ? order.updateTime : order.time;
}

/** Состояние открытой позиции во время прохода по журналу. */
type OpenPosition = {
  side: TradeSide;
  /** Остаток объёма, который ещё не закрыт. */
  quantity: number;
  /** Совокупный объём входа — по нему считается средняя цена входа. */
  entryQuantity: number;
  entryNotional: number;
  openedAt: number;
  entryOrderIds: string[];
  exitOrderIds: string[];
  closedPnl: number;
  closedQuantity: number;
  closedNotional: number;
  lastCloseAt: number;
  /** Цена стопа, выставленного по этой позиции (последний STOP_MARKET). */
  slPrice: number | null;
  /** Какой условный ордер сработал: по нему определяется причина закрытия. */
  closeReason: "sl" | "tp" | "manual";
};

function sideOfEntry(order: ImportOrder): TradeSide {
  return order.side.toUpperCase() === "BUY" ? "long" : "short";
}

function isClosingFor(position: OpenPosition, order: ImportOrder): boolean {
  const side = order.side.toUpperCase();
  return position.side === "long" ? side === "SELL" : side === "BUY";
}

/** Тип условного ордера → причина закрытия. */
function reasonOfConditional(type: string): "sl" | "tp" | null {
  const upper = type.toUpperCase();
  if (upper.includes("STOP")) return "sl";
  if (upper.includes("TAKE_PROFIT")) return "tp";
  return null;
}

/**
 * Собирает закрытые сделки из журнала ордеров ОДНОГО символа.
 *
 * Алгоритм — проход по времени исполнения: первый исполненный ордер открывает позицию,
 * встречные исполнения её закрывают (возможно, частями). Когда остаток объёма сходится
 * к нулю, сделка считается закрытой и попадает в результат.
 *
 * Позиция, открытая ДО начала окна запроса, в журнале выглядит как закрытие без входа:
 * такие ордера пропускаются с объяснением, иначе сделка получила бы выдуманную цену входа.
 */
export function buildTradesFromOrders(orders: ImportOrder[]): ImportBuildResult {
  const trades: ImportedTrade[] = [];
  const skipped: ImportSkip[] = [];

  // Справочник условных ордеров: сработавшее исполнение ссылается на них triggerOrderId.
  const conditionals = new Map<string, ImportOrder>();
  for (const order of orders) {
    if (reasonOfConditional(order.type) !== null) conditionals.set(order.orderId, order);
  }

  const filled = orders
    .filter((order) => FILLED_STATUSES.has(order.status.toUpperCase()) && order.executedQty > 0 && order.avgPrice > 0)
    .sort((a, b) => filledAt(a) - filledAt(b));

  let position: OpenPosition | null = null;

  for (const order of filled) {
    if (position === null) {
      position = {
        side: sideOfEntry(order),
        quantity: order.executedQty,
        entryQuantity: order.executedQty,
        entryNotional: order.executedQty * order.avgPrice,
        openedAt: filledAt(order),
        entryOrderIds: [order.orderId],
        exitOrderIds: [],
        closedPnl: 0,
        closedQuantity: 0,
        closedNotional: 0,
        lastCloseAt: filledAt(order),
        slPrice: slPriceFor(orders, order, sideOfEntry(order)),
        closeReason: "manual",
      };
      continue;
    }

    if (!isClosingFor(position, order)) {
      // Доливка в ту же сторону: средняя цена входа пересчитывается по объёму.
      position.quantity += order.executedQty;
      position.entryQuantity += order.executedQty;
      position.entryNotional += order.executedQty * order.avgPrice;
      position.entryOrderIds.push(order.orderId);
      continue;
    }

    const closingQty = Math.min(order.executedQty, position.quantity);
    position.quantity -= closingQty;
    position.closedQuantity += closingQty;
    position.closedNotional += closingQty * order.avgPrice;
    position.closedPnl += order.profit ?? 0;
    position.exitOrderIds.push(order.orderId);
    position.lastCloseAt = filledAt(order);

    // Причина закрытия — по исходному условному ордеру, а не по типу исполнения.
    const source = order.triggerOrderId ? conditionals.get(order.triggerOrderId) : undefined;
    const reason = reasonOfConditional(source?.type ?? order.type);
    if (reason) position.closeReason = reason;

    // Остаток меньше тысячной доли объёма — это float-шум, а не недозакрытая позиция.
    if (position.quantity > position.entryQuantity * 0.001) continue;

    trades.push(finishTrade(order.symbol, position));
    position = null;
  }

  if (position !== null) {
    // Позиция осталась открытой на конце окна — её сделка ещё не состоялась.
    skipped.push({
      symbol: orders[0]?.symbol ?? "",
      reason: "Позиция ещё открыта — сделка не закрыта",
      orderIds: position.entryOrderIds,
    });
  }

  return { trades, skipped };
}

/**
 * Цена стопа для позиции: ближайший по времени STOP_MARKET, выставленный ПОСЛЕ входа.
 * Берём первый такой ордер, а не последний: риск сделки считается от ИСХОДНОГО стопа,
 * как и везде в приложении (подтянутый стоп риск не переписывает).
 */
function slPriceFor(orders: ImportOrder[], entry: ImportOrder, side: TradeSide): number | null {
  const entryAt = filledAt(entry);
  const candidates = orders
    .filter((order) => reasonOfConditional(order.type) === "sl" && order.stopPrice !== null && order.time >= entryAt)
    .sort((a, b) => a.time - b.time);
  const stop = candidates[0]?.stopPrice ?? null;
  if (stop === null) return null;
  // Стоп обязан быть по «убыточную» сторону от входа — иначе это не стоп этой позиции.
  const valid = side === "long" ? stop < entry.avgPrice : stop > entry.avgPrice;
  return valid ? stop : null;
}

function finishTrade(symbol: string, position: OpenPosition): ImportedTrade {
  const entryPrice = position.entryNotional / position.entryQuantity;
  const closePrice = position.closedNotional / position.closedQuantity;
  const quantity = position.entryQuantity;
  const riskUsd =
    position.slPrice !== null ? computeRiskUsd(entryPrice, position.slPrice, quantity) : null;

  // PnL биржи — источник правды. Нулевой profit при реально ушедшей цене — известный
  // баг BingX на STOP_MARKET, поэтому в этом случае считаем по ценам (как computeResult).
  const fromPrices = computeResultFromPrices(
    position.side,
    entryPrice,
    closePrice,
    quantity,
    riskUsd ?? 0,
  );
  const priceBasedPnl =
    (position.side === "long" ? closePrice - entryPrice : entryPrice - closePrice) * quantity;
  const realizedPnlUsd =
    Math.abs(position.closedPnl) < 1e-8 && Math.abs(priceBasedPnl) > 1e-8
      ? priceBasedPnl
      : position.closedPnl;

  const notional = entryPrice * quantity;
  return {
    symbol,
    side: position.side,
    quantity,
    entryPrice,
    closePrice,
    slPrice: position.slPrice,
    openedAt: new Date(position.openedAt),
    closedAt: new Date(position.lastCloseAt),
    closeReason: position.closeReason,
    riskUsd,
    resultR: riskUsd !== null && riskUsd > 0 ? realizedPnlUsd / riskUsd : null,
    resultPct: notional > 0 ? (realizedPnlUsd / notional) * 100 : fromPrices.resultPct,
    realizedPnlUsd,
    orderIds: { entry: position.entryOrderIds, exit: position.exitOrderIds },
  };
}

/** Строка сводки по часу открытия — те же цифры, что в живой гистограмме «Сделки». */
export type ImportHourStat = {
  hour: number;
  total: number;
  tpCount: number;
};

/**
 * Сводка восстановленных сделок по часам ОТКРЫТИЯ — первый шаг восстановления данных
 * (просьба пользователя от 01.11.2026): увидеть прибыльные и убыточные часы раньше, чем
 * писать в базу саму историю.
 *
 * Считается ровно так же, как живая гистограмма (history/insights.ts): час берётся в
 * таймзоне риск-плана, исход — общим правилом (стоп, уведённый в прибыль, это тейк).
 * Иначе восстановленные часы расходились бы с теми, что появятся после импорта.
 *
 * Сделки без R в счёт не идут: в гистограмме их тоже нет — по ним нечего сказать
 * о результате часа.
 */
export function summarizeHours(
  trades: ImportedTrade[],
  tzOffsetMinutes: number,
): ImportHourStat[] {
  const buckets = new Map<number, ImportHourStat>();

  for (const trade of trades) {
    if (trade.resultR === null) continue;
    const hour = getLocalHour(trade.openedAt, tzOffsetMinutes);
    const bucket = buckets.get(hour) ?? { hour, total: 0, tpCount: 0 };
    bucket.total += 1;
    const outcome = resolveTradeOutcome(
      {
        closeReason: trade.closeReason,
        entryPrice: trade.entryPrice,
        slPrice: trade.slPrice,
        side: trade.side,
        statsOutcome: null,
      },
      trade.resultR,
    );
    if (outcome === "tp") bucket.tpCount += 1;
    buckets.set(hour, bucket);
  }

  return [...buckets.values()].sort((a, b) => a.hour - b.hour);
}

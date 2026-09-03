import {
  cancelOrder,
  placeOrder,
  type BingXCredentials,
  type OrderSide,
} from "../bingx/client.js";

/**
 * Общая ордерная механика, вынесенная из trades/service.ts, чтобы модули, которые
 * двигают стопы по событиям (trailingSlWatcher), не импортировали service целиком —
 * service сам импортирует их, и получился бы цикл.
 */

export function bingxMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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
export async function replaceConditionalOrder(
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

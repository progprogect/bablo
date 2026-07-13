export type PriceEvent = { symbol: string; price: number };
export type RefreshEvent = { reason: string };

/**
 * Подписка на серверный SSE-канал (`GET /api/events`). Возвращает функцию отписки.
 * Два типа событий — намеренно минимальный контракт (см. server/src/events/bus.ts):
 * `price` — живая цена символа (используется и для тикера, и для расчёта live PnL
 * на клиенте: entry/qty/side уже есть локально, тянуть PnL отдельным событием избыточно);
 * `refresh` — что-то изменилось на сервере (сделка/баланс/блокировки) → перезапросить дашборд.
 */
export function subscribeToEvents(handlers: {
  onPrice?: (event: PriceEvent) => void;
  onRefresh?: (event: RefreshEvent) => void;
}): () => void {
  const source = new EventSource("/api/events", { withCredentials: true });

  const priceListener = (event: MessageEvent) => {
    try {
      handlers.onPrice?.(JSON.parse(event.data) as PriceEvent);
    } catch {
      // игнорируем повреждённое сообщение — следующее придёт в течение секунды
    }
  };
  const refreshListener = (event: MessageEvent) => {
    try {
      handlers.onRefresh?.(JSON.parse(event.data) as RefreshEvent);
    } catch {
      // игнорируем
    }
  };

  source.addEventListener("price", priceListener);
  source.addEventListener("refresh", refreshListener);

  return () => {
    source.removeEventListener("price", priceListener);
    source.removeEventListener("refresh", refreshListener);
    source.close();
  };
}

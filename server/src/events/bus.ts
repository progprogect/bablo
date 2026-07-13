import { EventEmitter } from "node:events";

/**
 * Внутренняя событийная шина сервера. Реалтайм-коннекторы BingX (market/account WS)
 * публикуют события сюда, SSE-роут (`GET /api/events`) транслирует их клиенту.
 * Осознанно узкий набор событий — клиент либо обновляет цену точечно (частое событие),
 * либо просто перезапрашивает /api/dashboard (редкое событие, полный снимок проще
 * поддерживать, чем набор мелких патчей для баланса/блокировок/сделки).
 */
export type PriceUpdatedEvent = { symbol: string; price: number };
export type RefreshEvent = { reason: string };

type BusEvents = {
  price: PriceUpdatedEvent;
  refresh: RefreshEvent;
};

class TypedBus extends EventEmitter {
  emitTyped<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    this.emit(event, payload);
  }

  onTyped<K extends keyof BusEvents>(event: K, listener: (payload: BusEvents[K]) => void): void {
    this.on(event, listener);
  }

  offTyped<K extends keyof BusEvents>(event: K, listener: (payload: BusEvents[K]) => void): void {
    this.off(event, listener);
  }
}

export const eventBus = new TypedBus();
// Возможны десятки одновременных SSE-подписчиков (несколько открытых вкладок) — снимаем
// стандартный лимит EventEmitter (10), чтобы Node не логировал предупреждение о утечке.
eventBus.setMaxListeners(50);

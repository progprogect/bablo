import { useEffect } from "react";
import { subscribeToEvents } from "../api/sse";
import { initChimeUnlock, playTradeClosedChime } from "../lib/chime";

/**
 * Звуковой сигнал о закрытии сделки на уровне всего приложения — звенит на любом
 * экране, не только на дашборде. Отдельная SSE-подписка: дашборд размонтируется
 * при переходе в историю/админку, а сигнал должен жить всегда.
 */
export function TradeCloseChime() {
  useEffect(() => {
    initChimeUnlock();
    const unsubscribe = subscribeToEvents({
      onRefresh: ({ reason }) => {
        if (reason === "trade.closed") {
          playTradeClosedChime();
        }
      },
    });
    return unsubscribe;
  }, []);

  return null;
}

import type { FastifyInstance } from "fastify";
import { eventBus, type PriceUpdatedEvent, type RefreshEvent } from "../events/bus.js";
import { requireAuth } from "./plugins/auth-guard.js";

const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * SSE-канал клиенту: живая цена активов + сигнал "что-то изменилось, перезапроси дашборд"
 * (открытие/закрытие сделки, изменение баланса/блокировок). Один сервер → много вкладок:
 * каждое подключение просто подписывается на общую внутреннюю шину (`events/bus.ts`).
 */
export async function registerEventsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/events", { preHandler: requireAuth }, (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onPrice = (payload: PriceUpdatedEvent): void => send("price", payload);
    const onRefresh = (payload: RefreshEvent): void => send("refresh", payload);
    eventBus.onTyped("price", onPrice);
    eventBus.onTyped("refresh", onRefresh);

    // Комментарий-пинг раз в 25с — держит соединение живым через прокси Railway,
    // EventSource в браузере такие строки (с ":") игнорирует.
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), HEARTBEAT_INTERVAL_MS);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      eventBus.offTyped("price", onPrice);
      eventBus.offTyped("refresh", onRefresh);
    };
    request.raw.on("close", cleanup);
  });
}

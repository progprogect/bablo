import type { FastifyInstance } from "fastify";
import {
  blockHour,
  listManualBlocksView,
  ManualBlockValidationError,
  scheduleWindow,
} from "../risk/manualBlocksService.js";
import { requireAuth } from "./plugins/auth-guard.js";

/**
 * Ручные блокировки торговли («История» → «Настройки», risk/manualBlocks.ts): закрытые
 * часы суток со сроком и запланированные окна «дата + с … до». Эндпоинта удаления нет
 * НАМЕРЕННО: поставленную блокировку нельзя снять до истечения срока — в этом весь смысл
 * механизма, и сервер не должен давать обходного пути.
 */
export async function registerTradingBlockRoutes(app: FastifyInstance): Promise<void> {
  app.get("/trading-blocks", { preHandler: requireAuth }, async () => {
    return listManualBlocksView();
  });

  app.post<{ Body: { hour?: number; days?: number } }>(
    "/trading-blocks/hours",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { hour, days } = request.body ?? {};
      try {
        await blockHour(Number(hour), Number(days));
      } catch (error) {
        if (error instanceof ManualBlockValidationError) {
          reply.code(400).send({ error: error.message });
          return;
        }
        throw error;
      }
      return listManualBlocksView();
    },
  );

  app.post<{ Body: { date?: string; from?: string; to?: string } }>(
    "/trading-blocks/windows",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { date, from, to } = request.body ?? {};
      try {
        await scheduleWindow({ date: String(date ?? ""), from: String(from ?? ""), to: String(to ?? "") });
      } catch (error) {
        if (error instanceof ManualBlockValidationError) {
          reply.code(400).send({ error: error.message });
          return;
        }
        throw error;
      }
      return listManualBlocksView();
    },
  );
}

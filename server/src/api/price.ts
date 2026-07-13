import type { FastifyInstance } from "fastify";
import { BingXApiError, getContractLimits, getLatestPrice } from "../bingx/client.js";
import { requireAuth } from "./plugins/auth-guard.js";

export async function registerPriceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { symbol: string } }>(
    "/price/:symbol",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const price = await getLatestPrice(request.params.symbol);
        // Лимиты контракта — best-effort: если BingX недоступен для этого запроса,
        // цена всё равно должна вернуться, просто без клиентских подсказок по минимуму.
        const limits = await getContractLimits(request.params.symbol).catch(() => null);
        return {
          symbol: request.params.symbol,
          price,
          minQuantity: limits?.tradeMinQuantity ?? null,
          minNotionalUsdt: limits?.tradeMinUSDT ?? null,
        };
      } catch (error) {
        const message = error instanceof BingXApiError ? error.message : "Не удалось получить цену";
        reply.code(502).send({ error: message });
      }
    },
  );
}

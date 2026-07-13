import type { FastifyInstance } from "fastify";
import { BingXApiError, getLatestPrice } from "../bingx/client.js";
import { requireAuth } from "./plugins/auth-guard.js";

export async function registerPriceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { symbol: string } }>(
    "/price/:symbol",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const price = await getLatestPrice(request.params.symbol);
        return { symbol: request.params.symbol, price };
      } catch (error) {
        const message = error instanceof BingXApiError ? error.message : "Не удалось получить цену";
        reply.code(502).send({ error: message });
      }
    },
  );
}

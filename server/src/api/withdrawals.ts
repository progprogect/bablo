import type { FastifyInstance } from "fastify";
import {
  checkBingxWithdrawals,
  confirmWithdrawalManually,
  getWithdrawalsState,
  WithdrawalError,
} from "../withdrawals/service.js";
import { requireAuth } from "./plugins/auth-guard.js";

/**
 * Выводы прибыли по уровням (docs/RISK_ENGINE.md, правило #12): состояние, ручное
 * подтверждение и разовая сверка с историей выводов BingX.
 */
export async function registerWithdrawalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/withdrawals", { preHandler: requireAuth }, async () => getWithdrawalsState());

  app.post<{ Body: { id?: number; amountUsd?: number } }>(
    "/withdrawals/confirm",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id, amountUsd } = request.body ?? {};
      if (!Number.isInteger(id)) {
        reply.code(400).send({ error: "Укажите id требования вывода" });
        return;
      }
      if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd)) {
        reply.code(400).send({ error: "Укажите сумму вывода" });
        return;
      }
      try {
        return await confirmWithdrawalManually({ id: id as number, amountUsd });
      } catch (error) {
        if (error instanceof WithdrawalError) {
          reply.code(400).send({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );

  app.post("/withdrawals/check-bingx", { preHandler: requireAuth }, async () => checkBingxWithdrawals());
}

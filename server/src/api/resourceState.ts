import type { FastifyInstance } from "fastify";
import { getRiskSettings, getStoredResourceState, setStoredResourceState } from "../db/repositories/settings.js";
import { resolveResourceState, type ResourceStateView } from "../risk/resourceState.js";
import { getTradingDayKey } from "../risk/tradingDay.js";
import { requireAuth } from "./plugins/auth-guard.js";

/**
 * Текущее состояние отметки «в ресурсе» — всегда про сегодняшний ТОРГОВЫЙ день
 * (сброс в 07:00 по настройкам риск-плана, не в полночь). Используется и здесь,
 * и в ответе дашборда, чтобы поп-ап показывался без отдельного запроса.
 */
export async function getResourceStateView(now: Date = new Date()): Promise<ResourceStateView> {
  const [settings, stored] = await Promise.all([getRiskSettings(), getStoredResourceState()]);
  const dayKey = getTradingDayKey(now, settings.resetHour, settings.tzOffsetMinutes);
  return resolveResourceState(stored, dayKey);
}

export async function registerResourceStateRoutes(app: FastifyInstance): Promise<void> {
  app.get("/resource-state", { preHandler: requireAuth }, async () => getResourceStateView());

  app.post<{ Body: { isResourceful?: boolean } }>(
    "/resource-state",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { isResourceful } = request.body ?? {};
      if (typeof isResourceful !== "boolean") {
        reply.code(400).send({ error: "Укажите isResourceful: true или false" });
        return;
      }

      const settings = await getRiskSettings();
      const dayKey = getTradingDayKey(new Date(), settings.resetHour, settings.tzOffsetMinutes);
      await setStoredResourceState({
        dayKey,
        isResourceful,
        answeredAt: new Date().toISOString(),
      });
      return { dayKey, answered: true, isResourceful } satisfies ResourceStateView;
    },
  );
}

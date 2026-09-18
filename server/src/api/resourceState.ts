import type { FastifyInstance } from "fastify";
import { getLastClosedTrade } from "../db/repositories/trades.js";
import { getRiskSettings, getStoredResourceState, setStoredResourceState } from "../db/repositories/settings.js";
import { resolveResourceState, type ResourceStateView } from "../risk/resourceState.js";
import { getTradingDayKey } from "../risk/tradingDay.js";
import { requireAuth } from "./plugins/auth-guard.js";

/**
 * Нужно ли спросить «в ресурсе?» прямо сейчас. Две точки пересборки — новый торговый день
 * и конец перерыва после сделки (см. risk/resourceState.ts), поэтому кроме сохранённого
 * ответа смотрим на последнюю закрытую сделку и длину кулдауна из риск-настроек.
 * Используется и роутом ниже, и ответом дашборда — чтобы поп-ап не стоил лишнего запроса.
 */
export async function getResourceStateView(now: Date = new Date()): Promise<ResourceStateView> {
  const [settings, stored, lastClosed] = await Promise.all([
    getRiskSettings(),
    getStoredResourceState(),
    getLastClosedTrade(),
  ]);
  return resolveResourceState({
    stored,
    todayKey: getTradingDayKey(now, settings.resetHour, settings.tzOffsetMinutes),
    now,
    lastTradeClosedAt: lastClosed?.closedAt ?? null,
    cooldownMinutes: settings.cooldownMinutes,
  });
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
      const now = new Date();
      const dayKey = getTradingDayKey(now, settings.resetHour, settings.tzOffsetMinutes);
      await setStoredResourceState({ dayKey, isResourceful, answeredAt: now.toISOString() });
      // Ответ только что сохранён — состояние заведомо «отвечено», лишний раз не считаем.
      return { dayKey, answered: true, isResourceful, askReason: null } satisfies ResourceStateView;
    },
  );
}

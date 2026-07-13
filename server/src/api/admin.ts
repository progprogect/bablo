import type { FastifyInstance } from "fastify";
import { BingXApiError, getBalance } from "../bingx/client.js";
import {
  createAsset,
  deleteAsset,
  listAssets,
  updateAsset,
  type CreateAssetInput,
  type UpdateAssetInput,
} from "../db/repositories/assets.js";
import { getBingxCredentials, setBingxCredentials, getRiskSettings, setRiskSettings } from "../db/repositories/settings.js";
import { listRiskLevels, updateRiskLevel } from "../db/repositories/riskLevels.js";
import { resyncMarketSymbols, restartAccountStream } from "../realtime/manager.js";
import { requireAuth } from "./plugins/auth-guard.js";

const MAX_LEVERAGE = 125;

function isValidLeverage(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_LEVERAGE;
}

function normalizeSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // --- BingX ключи ---

  app.get("/admin/bingx-key", async () => {
    const credentials = await getBingxCredentials();
    return { configured: credentials !== null };
  });

  app.post<{ Body: { apiKey?: string; secretKey?: string } }>(
    "/admin/bingx-key",
    async (request, reply) => {
      const { apiKey, secretKey } = request.body ?? {};
      if (!apiKey?.trim() || !secretKey?.trim()) {
        reply.code(400).send({ error: "Укажите apiKey и secretKey" });
        return;
      }

      const credentials = { apiKey: apiKey.trim(), secretKey: secretKey.trim() };

      try {
        const balance = await getBalance(credentials);
        await setBingxCredentials(credentials);
        // Рестарт account-стрима не должен ломать сохранение ключей: ключи уже валидны
        // и записаны в БД, даже если WS не поднялся с первой попытки.
        try {
          await restartAccountStream();
        } catch (streamError) {
          request.log.warn({ err: streamError }, "Ключи сохранены, но account-стрим не перезапустился");
        }
        const equity = balance.equity ?? balance.balance ?? null;
        return { configured: true, balance, equity };
      } catch (error) {
        const message = error instanceof BingXApiError ? error.message : "Не удалось подключиться к BingX";
        reply.code(502).send({ error: message });
      }
    },
  );

  // --- Активы ---

  app.get("/admin/assets", async () => {
    return listAssets();
  });

  app.post<{ Body: Partial<CreateAssetInput> }>("/admin/assets", async (request, reply) => {
    const symbol = normalizeSymbol(request.body?.symbol);
    const leverage = request.body?.leverage;

    if (!symbol || !isValidLeverage(leverage)) {
      reply.code(400).send({ error: `Укажите symbol и leverage (1–${MAX_LEVERAGE})` });
      return;
    }

    const asset = await createAsset({
      symbol,
      leverage,
      sortOrder: request.body?.sortOrder,
      isActive: request.body?.isActive,
    });
    await resyncMarketSymbols();
    reply.code(201);
    return asset;
  });

  app.patch<{ Params: { id: string }; Body: Partial<UpdateAssetInput> }>(
    "/admin/assets/:id",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        reply.code(400).send({ error: "Некорректный id" });
        return;
      }

      const patch: UpdateAssetInput = {};
      if (request.body?.symbol !== undefined) {
        const symbol = normalizeSymbol(request.body.symbol);
        if (!symbol) {
          reply.code(400).send({ error: "Некорректный symbol" });
          return;
        }
        patch.symbol = symbol;
      }
      if (request.body?.leverage !== undefined) {
        if (!isValidLeverage(request.body.leverage)) {
          reply.code(400).send({ error: `leverage должен быть от 1 до ${MAX_LEVERAGE}` });
          return;
        }
        patch.leverage = request.body.leverage;
      }
      if (request.body?.sortOrder !== undefined) {
        patch.sortOrder = request.body.sortOrder;
      }
      if (request.body?.isActive !== undefined) {
        patch.isActive = request.body.isActive;
      }

      const updated = await updateAsset(id, patch);
      if (!updated) {
        reply.code(404).send({ error: "Актив не найден" });
        return;
      }
      await resyncMarketSymbols();
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>("/admin/assets/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      reply.code(400).send({ error: "Некорректный id" });
      return;
    }
    await deleteAsset(id);
    await resyncMarketSymbols();
    reply.code(204);
  });

  // --- Риск-план: лестница уровней ---

  app.get("/admin/risk-levels", async () => {
    return listRiskLevels();
  });

  app.patch<{ Params: { level: string }; Body: { riskUsd?: number; requiredR?: number } }>(
    "/admin/risk-levels/:level",
    async (request, reply) => {
      const level = Number(request.params.level);
      if (!Number.isInteger(level)) {
        reply.code(400).send({ error: "Некорректный level" });
        return;
      }

      const { riskUsd, requiredR } = request.body ?? {};
      if (riskUsd !== undefined && !(typeof riskUsd === "number" && riskUsd > 0)) {
        reply.code(400).send({ error: "riskUsd должен быть больше нуля" });
        return;
      }
      if (requiredR !== undefined && !(typeof requiredR === "number" && requiredR > 0)) {
        reply.code(400).send({ error: "requiredR должен быть больше нуля" });
        return;
      }

      const updated = await updateRiskLevel(level, { riskUsd, requiredR });
      if (!updated) {
        reply.code(404).send({ error: "Уровень не найден" });
        return;
      }
      return updated;
    },
  );

  // --- Риск-план: параметры (кулдаун, дневные лимиты, час сброса) ---

  app.get("/admin/risk-settings", async () => {
    return getRiskSettings();
  });

  app.put<{
    Body: Partial<{
      cooldownMinutes: number;
      dailyLossLimitR: number;
      dailyProfitLimitR: number;
      resetHour: number;
      tzOffsetMinutes: number;
    }>;
  }>("/admin/risk-settings", async (request, reply) => {
    const body = request.body ?? {};
    const patch: Partial<{
      cooldownMinutes: number;
      dailyLossLimitR: number;
      dailyProfitLimitR: number;
      resetHour: number;
      tzOffsetMinutes: number;
    }> = {};

    if (body.cooldownMinutes !== undefined) {
      if (!(Number.isFinite(body.cooldownMinutes) && body.cooldownMinutes >= 0)) {
        reply.code(400).send({ error: "cooldownMinutes должен быть ≥ 0" });
        return;
      }
      patch.cooldownMinutes = body.cooldownMinutes;
    }
    if (body.dailyLossLimitR !== undefined) {
      if (!(Number.isFinite(body.dailyLossLimitR) && body.dailyLossLimitR < 0)) {
        reply.code(400).send({ error: "dailyLossLimitR должен быть отрицательным" });
        return;
      }
      patch.dailyLossLimitR = body.dailyLossLimitR;
    }
    if (body.dailyProfitLimitR !== undefined) {
      if (!(Number.isFinite(body.dailyProfitLimitR) && body.dailyProfitLimitR > 0)) {
        reply.code(400).send({ error: "dailyProfitLimitR должен быть положительным" });
        return;
      }
      patch.dailyProfitLimitR = body.dailyProfitLimitR;
    }
    if (body.resetHour !== undefined) {
      if (!(Number.isInteger(body.resetHour) && body.resetHour >= 0 && body.resetHour <= 23)) {
        reply.code(400).send({ error: "resetHour должен быть от 0 до 23" });
        return;
      }
      patch.resetHour = body.resetHour;
    }
    if (body.tzOffsetMinutes !== undefined) {
      if (!(Number.isInteger(body.tzOffsetMinutes) && body.tzOffsetMinutes >= -720 && body.tzOffsetMinutes <= 840)) {
        reply.code(400).send({ error: "tzOffsetMinutes вне допустимого диапазона" });
        return;
      }
      patch.tzOffsetMinutes = body.tzOffsetMinutes;
    }

    return setRiskSettings(patch);
  });
}

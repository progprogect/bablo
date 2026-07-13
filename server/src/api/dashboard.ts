import type { FastifyInstance } from "fastify";
import { BingXApiError, getBalance } from "../bingx/client.js";
import { listActiveAssets } from "../db/repositories/assets.js";
import { getBingxCredentials } from "../db/repositories/settings.js";
import { getRiskSnapshot } from "../risk/service.js";
import { getActiveTradeView } from "../trades/service.js";
import { requireAuth } from "./plugins/auth-guard.js";

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/dashboard", { preHandler: requireAuth }, async () => {
    const [credentials, assets, activeTrade, risk] = await Promise.all([
      getBingxCredentials(),
      listActiveAssets(),
      getActiveTradeView(),
      getRiskSnapshot(),
    ]);

    if (!credentials) {
      return {
        balance: null,
        balanceError: "Ключи BingX не настроены — добавьте их в админке",
        assets,
        activeTrade,
        risk,
      };
    }

    try {
      const balance = await getBalance(credentials);
      return { balance, balanceError: null, assets, activeTrade, risk };
    } catch (error) {
      const message =
        error instanceof BingXApiError ? error.message : "Не удалось получить баланс BingX";
      return { balance: null, balanceError: message, assets, activeTrade, risk };
    }
  });
}

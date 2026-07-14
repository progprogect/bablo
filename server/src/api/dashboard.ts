import type { FastifyInstance } from "fastify";
import { BingXApiError, getBalance } from "../bingx/client.js";
import { listActiveAssets } from "../db/repositories/assets.js";
import { captureEquitySnapshotIfMissing } from "../db/repositories/equitySnapshots.js";
import { getBingxCredentials, getRiskSettings } from "../db/repositories/settings.js";
import { getRiskSnapshot } from "../risk/service.js";
import { getLocalDateKey } from "../risk/tradingDay.js";
import { getActiveTradeView, getExternalPositions } from "../trades/service.js";
import { requireAuth } from "./plugins/auth-guard.js";

/**
 * Лениво фиксирует эквити на сегодняшний календарный день — не чаще одного раза
 * (captureEquitySnapshotIfMissing не перезаписывает существующий снимок). Без этого
 * "% к депозиту" в месячной статистике невозможно посчитать для месяцев без снимков —
 * истории баланса до сих пор не было. Best-effort: ошибка не должна портить дашборд.
 */
async function captureTodaysEquity(equity: string | number | null | undefined): Promise<void> {
  const value = Number(equity);
  if (!Number.isFinite(value)) return;
  try {
    const settings = await getRiskSettings();
    const dateKey = getLocalDateKey(new Date(), settings.tzOffsetMinutes);
    await captureEquitySnapshotIfMissing(dateKey, value);
  } catch (error) {
    console.error("[dashboard] не удалось сохранить снимок эквити:", error);
  }
}

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/dashboard", { preHandler: requireAuth }, async () => {
    const [credentials, assets, activeTrade, risk] = await Promise.all([
      getBingxCredentials(),
      listActiveAssets(),
      getActiveTradeView(),
      getRiskSnapshot(),
    ]);
    const externalPositions = await getExternalPositions(activeTrade?.symbol);

    if (!credentials) {
      return {
        balance: null,
        balanceError: "Ключи BingX не настроены — добавьте их в админке",
        assets,
        activeTrade,
        externalPositions,
        risk,
      };
    }

    try {
      const balance = await getBalance(credentials);
      void captureTodaysEquity(balance.equity);
      return { balance, balanceError: null, assets, activeTrade, externalPositions, risk };
    } catch (error) {
      const message =
        error instanceof BingXApiError ? error.message : "Не удалось получить баланс BingX";
      return { balance: null, balanceError: message, assets, activeTrade, externalPositions, risk };
    }
  });
}

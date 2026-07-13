import { listActiveAssets } from "../db/repositories/assets.js";
import { getBingxCredentials } from "../db/repositories/settings.js";
import { getActiveTrade } from "../db/repositories/trades.js";
import { eventBus } from "../events/bus.js";
import { startTracking } from "../tracker/activeTradeTracker.js";
import { startAccountStream, stopAccountStream } from "./accountStream.js";
import { setMarketStreamSymbols, startMarketStream } from "./marketStream.js";
import { reconcileOrderUpdate, reconcilePositionFlat } from "./reconcile.js";

let marketStarted = false;

/** Запускает публичный ценовой стрим и (если есть ключи) приватный account-стрим. Вызывается один раз при старте сервера. */
export async function startRealtime(): Promise<void> {
  const assets = await listActiveAssets();
  const symbols = assets.map((a) => a.symbol);
  if (!marketStarted) {
    startMarketStream(symbols);
    marketStarted = true;
  } else {
    setMarketStreamSymbols(symbols);
  }

  await restartAccountStream();

  // Сервер мог перезапуститься (деплой) с уже активной сделкой — трекер MFE/безубытка
  // живёт только в памяти, восстанавливаем его от текущего состояния сделки в БД.
  // hasBeenInProfit при этом сбрасывается — приемлемая потеря точности при рестарте,
  // сама сделка и риск-движок от этого не зависят (см. tracker/activeTradeTracker.ts).
  const activeTrade = await getActiveTrade().catch(() => null);
  if (activeTrade) {
    startTracking(activeTrade);
  }
}

/** Пересобрать подписки market-стрима под текущий список активных активов (после изменений в админке). */
export async function resyncMarketSymbols(): Promise<void> {
  const assets = await listActiveAssets();
  setMarketStreamSymbols(assets.map((a) => a.symbol));
}

/** Перезапускает account-стрим с текущими ключами BingX (или останавливает, если ключей нет). Вызывается после сохранения ключей в админке. */
export async function restartAccountStream(): Promise<void> {
  const credentials = await getBingxCredentials();
  if (!credentials) {
    stopAccountStream();
    return;
  }

  startAccountStream(credentials, {
    onAccountUpdate: (positions) => {
      for (const position of positions) {
        if (Math.abs(Number(position.pa)) < 1e-9) {
          reconcilePositionFlat(position.s).catch((error) => {
            console.error("[realtime] сверка закрытой позиции не удалась:", error);
          });
        }
      }
      eventBus.emitTyped("refresh", { reason: "balance.updated" });
    },
    onOrderUpdate: (order) => {
      reconcileOrderUpdate(order).catch((error) => {
        console.error("[realtime] сверка исполненного ордера не удалась:", error);
      });
    },
  });
}

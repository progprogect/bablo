import { getPositions } from "../bingx/client.js";
import { listActiveAssets } from "../db/repositories/assets.js";
import { getBingxCredentials } from "../db/repositories/settings.js";
import { getActiveTrade } from "../db/repositories/trades.js";
import { eventBus } from "../events/bus.js";
import { repairActiveTradeSlAfterPartial } from "../trades/service.js";
import { startNightTakeProfitScheduler } from "../trades/nightTpScheduler.js";
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
    // Сделка могла закрыться по SL/TP, пока сервер лежал: ACCOUNT_UPDATE за это время
    // потерян, и без сверки она осталась бы "active" до ручного нажатия «Закрыть» —
    // с причиной "external" вместо реального тейка (ночной TP 1/1 срабатывает как раз
    // ночью, когда деплой/рестарт наиболее вероятен). Разовая проверка позиции по
    // событию старта — не поллинг.
    const closedWhileDown = await reconcileIfPositionAlreadyFlat(activeTrade.symbol);
    if (!closedWhileDown) {
      startTracking(activeTrade);
    }
  }

  // Если partial на 1/2 или 1/3 уже исполнилась до рестарта, а SL ещё исходный —
  // подтянуть по правилу 2R (1/2→вход, 1/3→1/1). Без поллинга: одноразово при старте.
  try {
    const repair = await repairActiveTradeSlAfterPartial();
    if (repair.attempted && repair.moved) {
      console.info("[realtime] SL подтянут после partial (repair при старте)");
    } else if (repair.attempted && repair.warning) {
      console.warn("[realtime] repair SL после partial:", repair.warning);
    }
  } catch (error) {
    console.error("[realtime] repairActiveTradeSlAfterPartial не удался:", error);
  }

  // Ночное правило TP 1/1: если сейчас ночь (с 01:00 МСК) и дневная сделка ещё
  // открыта — поджать; иначе одноразовый таймер до 01:00 (без циклического опроса).
  try {
    await startNightTakeProfitScheduler();
  } catch (error) {
    console.error("[realtime] startNightTakeProfitScheduler не удался:", error);
  }
}

/**
 * Если позиции по символу на бирже уже нет, а в БД сделка ещё активна — досверяем
 * закрытие обычным путём (reconcilePositionFlat найдёт исполнившийся SL/TP и запишет
 * реальную причину). Возвращает true, если сделка была закрыта этой сверкой.
 * Best-effort: любая ошибка BingX оставляет сделку активной, как и раньше.
 */
async function reconcileIfPositionAlreadyFlat(symbol: string): Promise<boolean> {
  try {
    const credentials = await getBingxCredentials();
    if (!credentials) return false;
    const positions = await getPositions(credentials, symbol);
    if (positions.some((p) => Number(p.positionAmt) !== 0)) return false;

    await reconcilePositionFlat(symbol);
    const stillActive = await getActiveTrade().catch(() => null);
    const closed = stillActive === null || stillActive.symbol !== symbol;
    if (closed) {
      console.info(`[realtime] сделка по ${symbol} закрылась, пока сервер был недоступен — сверено при старте`);
    }
    return closed;
  } catch (error) {
    console.error("[realtime] сверка закрытия при старте не удалась:", error);
    return false;
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

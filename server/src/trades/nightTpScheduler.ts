import { getRiskSettings } from "../db/repositories/settings.js";
import { DEFAULT_NIGHT_START_HOUR, getNextNightStartAt } from "../risk/tradingDay.js";
import { applyNightTakeProfitForActiveTrade } from "../trades/service.js";

/**
 * Одноразовые таймеры до следующего начала ночи (не setInterval / не поллинг).
 * В 00:00 МСК — попытка поджать TP дневной сделки до 1/1.
 */
let nightTimer: ReturnType<typeof setTimeout> | null = null;

const MAX_TIMEOUT_MS = 2_147_483_647; // лимит setTimeout в Node

async function runNightTpPass(): Promise<void> {
  try {
    const result = await applyNightTakeProfitForActiveTrade();
    if (result.applied) {
      console.info("[nightTp] TP поджат до 1/1 на ночь");
    } else if (result.attempted && result.warning) {
      console.info("[nightTp]", result.warning);
    }
  } catch (error) {
    console.error("[nightTp] сбой применения:", error);
  }
}

function clearNightTimer(): void {
  if (nightTimer !== null) {
    clearTimeout(nightTimer);
    nightTimer = null;
  }
}

function armTimer(delayMs: number, fire: () => void): void {
  clearNightTimer();
  if (delayMs > MAX_TIMEOUT_MS) {
    nightTimer = setTimeout(() => armTimer(delayMs - MAX_TIMEOUT_MS, fire), MAX_TIMEOUT_MS);
    return;
  }
  nightTimer = setTimeout(fire, Math.max(0, delayMs));
}

async function scheduleNextNight(): Promise<void> {
  const settings = await getRiskSettings();
  const now = new Date();
  const next = getNextNightStartAt(now, DEFAULT_NIGHT_START_HOUR, settings.tzOffsetMinutes);
  const delayMs = next.getTime() - now.getTime();
  console.info(`[nightTp] следующий проход в ${next.toISOString()} (через ${Math.round(delayMs / 1000)}с)`);

  armTimer(delayMs, () => {
    void (async () => {
      await runNightTpPass();
      await scheduleNextNight().catch((error) => {
        console.error("[nightTp] не удалось перепланировать:", error);
      });
    })();
  });
}

/**
 * Старт ночного правила: если сейчас уже ночь — применить сразу (деплой/рестарт),
 * затем поставить таймер на следующие 00:00 МСК.
 */
export async function startNightTakeProfitScheduler(): Promise<void> {
  await runNightTpPass();
  await scheduleNextNight();
}

/** Для тестов / остановки процесса. */
export function stopNightTakeProfitScheduler(): void {
  clearNightTimer();
}

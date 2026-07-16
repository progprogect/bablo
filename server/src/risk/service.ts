import { getPositions, type BingXCredentials } from "../bingx/client.js";
import { ensureSeedRiskLevels, listRiskLevelDefs } from "../db/repositories/riskLevels.js";
import { getOrCreateRiskState, updateRiskState } from "../db/repositories/riskState.js";
import { getDailySumR, addTradeResultToDailyStats } from "../db/repositories/dailyStats.js";
import { listActiveLocks, replaceManagedLocks } from "../db/repositories/riskLocks.js";
import { getRiskSettings } from "../db/repositories/settings.js";
import { getActiveTrade } from "../db/repositories/trades.js";
import { computeRiskUsd } from "../trades/math.js";
import { applyTradeResult, computeMaxQuantity, getLevelDef } from "./ladder.js";
import { evaluateCooldownBlock, evaluateDailyLimitBlocks, pickEffectiveBlock, type Block, type BlockType } from "./limits.js";
import { getTradingDayKey } from "./tradingDay.js";

export class RiskBlockedError extends Error {
  constructor(
    message: string,
    public readonly until: Date | null = null,
  ) {
    super(message);
    this.name = "RiskBlockedError";
  }
}

export async function ensureRiskSeeded(): Promise<void> {
  await ensureSeedRiskLevels();
  await getOrCreateRiskState();
}

export type RiskSnapshot = {
  currentLevel: number;
  levelRiskUsd: number;
  accumulatedR: number;
  requiredR: number | null;
  dailySumR: number;
  hasActiveTrade: boolean;
  activeLocks: Array<{ type: string; reason: string; until: string }>;
};

export async function getRiskSnapshot(): Promise<RiskSnapshot> {
  const now = new Date();
  const [stateRow, levels, settings, activeTrade, locks] = await Promise.all([
    getOrCreateRiskState(),
    listRiskLevelDefs(),
    getRiskSettings(),
    getActiveTrade(),
    listActiveLocks(now),
  ]);

  const dayKey = getTradingDayKey(now, settings.resetHour, settings.tzOffsetMinutes);
  const dailySumR = await getDailySumR(dayKey);
  const levelDef = getLevelDef(levels, stateRow.currentLevel);

  return {
    currentLevel: stateRow.currentLevel,
    levelRiskUsd: levelDef?.riskUsd ?? 0,
    accumulatedR: Number(stateRow.accumulatedR),
    requiredR: levelDef?.requiredR ?? null,
    dailySumR,
    hasActiveTrade: activeTrade !== null,
    activeLocks: locks.map((l) => ({ type: l.type, reason: l.reason, until: l.until.toISOString() })),
  };
}

/**
 * Бросает RiskBlockedError, если открывать новую сделку сейчас нельзя. Кроме сделки,
 * уже отслеживаемой в БД, и активных блокировок, проверяет реальные позиции на BingX —
 * пользователь мог открыть позицию вручную на самой бирже, минуя приложение. Пока на
 * аккаунте есть хоть одна открытая позиция (наша или сторонняя), параллельно открывать
 * новую нельзя — иначе фактический риск на счету перестанет соответствовать риск-плану.
 * Проверка BingX best-effort: если REST недоступен, не блокируем открытие только из-за
 * этого — остальные проверки (БД, локи) продолжают действовать как обычно.
 */
export async function checkCanOpenTrade(credentials: BingXCredentials | null): Promise<void> {
  const activeTrade = await getActiveTrade();
  if (activeTrade) {
    throw new RiskBlockedError("Уже есть активная сделка");
  }

  const locks = await listActiveLocks();
  const effective = pickEffectiveBlock(
    locks.map((l) => ({ type: l.type as BlockType, reason: l.reason, until: l.until })),
  );
  if (effective) {
    throw new RiskBlockedError(effective.reason, effective.until);
  }

  if (credentials) {
    const positions = await getPositions(credentials).catch(() => []);
    const openPosition = positions.find((p) => Number(p.positionAmt) !== 0);
    if (openPosition) {
      throw new RiskBlockedError(
        `На BingX уже открыта позиция по ${openPosition.symbol.replace(/-USDT$/, "")} — она была открыта не через приложение. Закройте её, прежде чем открывать новую сделку.`,
      );
    }
  }
}

/**
 * Допустимое отклонение риска сделки от плана текущего уровня — в обе стороны. Риск-план
 * задаёт конкретную сумму 1R не просто как потолок, а как ориентир: сделка с риском заметно
 * МЕНЬШЕ плана так же нарушает дисциплину лестницы, как и сделка с риском больше плана
 * (прогресс перестаёт соответствовать заложенным шагам). 20% — разумный люфт на округление
 * объёма/цены SL и на дрожание цены между вводом в форме и моментом подтверждения; более
 * заметные отклонения означают, что объём или SL посчитаны неверно.
 */
export const RISK_SIZE_TOLERANCE_RATIO = 0.2;

/** Бросает RiskBlockedError, если риск сделки выходит за пределы ±20% от 1R текущего уровня. */
export async function checkVolumeRisk(currentPrice: number, slPrice: number, quantity: number): Promise<void> {
  const [stateRow, levels] = await Promise.all([getOrCreateRiskState(), listRiskLevelDefs()]);
  const levelDef = getLevelDef(levels, stateRow.currentLevel);
  if (!levelDef) {
    return;
  }

  const riskUsd = computeRiskUsd(currentPrice, slPrice, quantity);
  const minAllowed = levelDef.riskUsd * (1 - RISK_SIZE_TOLERANCE_RATIO);
  const maxAllowed = levelDef.riskUsd * (1 + RISK_SIZE_TOLERANCE_RATIO);
  const tolerancePct = Math.round(RISK_SIZE_TOLERANCE_RATIO * 100);

  if (riskUsd > maxAllowed) {
    const targetQuantity = computeMaxQuantity(currentPrice, slPrice, levelDef.riskUsd);
    throw new RiskBlockedError(
      `Риск сделки ${riskUsd.toFixed(2)} USDT выше плана ${levelDef.riskUsd} USDT (допуск ±${tolerancePct}%). Уменьшите объём до ≈${targetQuantity.toFixed(4)}`,
    );
  }
  if (riskUsd < minAllowed) {
    const targetQuantity = computeMaxQuantity(currentPrice, slPrice, levelDef.riskUsd);
    throw new RiskBlockedError(
      `Риск сделки ${riskUsd.toFixed(2)} USDT ниже плана ${levelDef.riskUsd} USDT (допуск ±${tolerancePct}%). Увеличьте объём до ≈${targetQuantity.toFixed(4)}`,
    );
  }
}

/**
 * Постфактум-учёт результата закрытой сделки: прогресс лестницы уровней, дневной
 * агрегат и пересборка активных блокировок (кулдаун + дневные лимиты). Риск-движок
 * никогда не закрывает сделки сам — эта функция вызывается ПОСЛЕ фактического закрытия.
 */
export async function recordTradeClose(input: {
  closedAt: Date;
  resultR: number;
  closeReason: string;
}): Promise<void> {
  const settings = await getRiskSettings();
  const dayKey = getTradingDayKey(input.closedAt, settings.resetHour, settings.tzOffsetMinutes);

  const [stateRow, levels] = await Promise.all([getOrCreateRiskState(), listRiskLevelDefs()]);
  const nextState = applyTradeResult(
    { currentLevel: stateRow.currentLevel, accumulatedR: Number(stateRow.accumulatedR) },
    input.resultR,
    levels,
  );
  await updateRiskState(stateRow.id, nextState);

  const dailyStatsRow = await addTradeResultToDailyStats(dayKey, input.resultR, input.closeReason === "sl");

  const blocks: Block[] = evaluateDailyLimitBlocks(
    input.closedAt,
    Number(dailyStatsRow.sumR),
    dailyStatsRow.slCount,
    settings,
  );
  const cooldownBlock = evaluateCooldownBlock(input.closedAt, input.closedAt, settings.cooldownMinutes);
  if (cooldownBlock) {
    blocks.push(cooldownBlock);
  }
  await replaceManagedLocks(blocks);
}

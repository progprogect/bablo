import { getPositions, type BingXCredentials } from "../bingx/client.js";
import { ensureSeedRiskLevels, listRiskLevelDefs } from "../db/repositories/riskLevels.js";
import { getOrCreateRiskState, updateRiskState } from "../db/repositories/riskState.js";
import {
  getDailySumR,
  addTradeResultToDailyStats,
  replaceDailyStats,
} from "../db/repositories/dailyStats.js";
import { listActiveLocks, replaceManagedLocks } from "../db/repositories/riskLocks.js";
import { getRiskSettings } from "../db/repositories/settings.js";
import { getActiveTrade, listAllClosedTrades, updateTrade } from "../db/repositories/trades.js";
import { computeRiskUsd, parseRRRatio } from "../trades/math.js";
import { computeResult } from "../trades/result.js";
import { applyTradeResult, computeMaxQuantity, getLevelDef } from "./ladder.js";
import {
  evaluateCooldownBlock,
  evaluateDailyLimitBlocks,
  isStrongTakeProfit,
  pickEffectiveBlock,
  type Block,
  type BlockType,
} from "./limits.js";
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
  /** Пресет R/R сделки — для страховки дневного лимита +3R при тейке по плану ≥ 1:3. */
  rrPreset?: string | null;
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

  const resultRForDaily = resultRForDailyStats(
    input.closeReason,
    input.resultR,
    input.rrPreset,
    settings.dailyProfitLimitR,
  );

  const dailyStatsRow = await addTradeResultToDailyStats(dayKey, {
    resultR: resultRForDaily,
    closeReason: input.closeReason,
  });

  const blocks: Block[] = evaluateDailyLimitBlocks(
    input.closedAt,
    {
      sumR: Number(dailyStatsRow.sumR),
      slCount: dailyStatsRow.slCount,
      tpCount: dailyStatsRow.tpCount,
      strongRecoveryAfterSl: dailyStatsRow.strongRecoveryAfterSl,
    },
    settings,
  );
  const cooldownBlock = evaluateCooldownBlock(input.closedAt, input.closedAt, settings.cooldownMinutes);
  if (cooldownBlock) {
    blocks.push(cooldownBlock);
  }
  await replaceManagedLocks(blocks);
}

/**
 * R для дневного агрегата: при тейке с планом ≥ цели дня (+3R) не меньше цели —
 * страховка от комиссий и старого недоучёта partial.
 */
function resultRForDailyStats(
  closeReason: string | null,
  resultR: number,
  rrPreset: string | null | undefined,
  dailyProfitLimitR: number,
): number {
  const plannedRatio = rrPreset ? parseRRRatio(rrPreset) : null;
  if (closeReason === "tp" && plannedRatio !== null && plannedRatio >= dailyProfitLimitR) {
    return Math.max(resultR, dailyProfitLimitR);
  }
  return resultR;
}

/**
 * Пересчитывает дневной агрегат и блокировки за текущий торговый день по факту
 * закрытых сделок. Нужен, чтобы применить исправленный расчёт R (partial) и правило
 * +3R постфактум — без ожидания новой сделки. Идемпотентно, безопасно при каждом старте.
 */
export async function resyncTradingDayRisk(now: Date = new Date()): Promise<{
  dayKey: string;
  tradesCount: number;
  sumR: number;
  tradesFixed: number;
  lockTypes: string[];
}> {
  const settings = await getRiskSettings();
  const dayKey = getTradingDayKey(now, settings.resetHour, settings.tzOffsetMinutes);

  const allClosed = await listAllClosedTrades();
  const dayTrades = allClosed
    .filter((trade) => {
      if (!trade.closedAt) return false;
      return getTradingDayKey(trade.closedAt, settings.resetHour, settings.tzOffsetMinutes) === dayKey;
    })
    .sort((a, b) => {
      const aMs = a.closedAt ? new Date(a.closedAt).getTime() : 0;
      const bMs = b.closedAt ? new Date(b.closedAt).getTime() : 0;
      return aMs - bMs;
    });

  let tradesFixed = 0;
  for (const trade of dayTrades) {
    if (!trade.partialTpFilledAt || trade.closePrice == null) continue;
    const closePrice = Number(trade.closePrice);
    if (!Number.isFinite(closePrice)) continue;
    const { resultR, resultPct } = computeResult(trade, closePrice, null);
    const previous = trade.resultR !== null ? Number(trade.resultR) : null;
    if (previous !== null && Math.abs(previous - resultR) < 0.01) continue;
    await updateTrade(trade.id, { resultR, resultPct });
    trade.resultR = String(resultR);
    trade.resultPct = String(resultPct);
    tradesFixed += 1;
  }

  let sumR = 0;
  let slCount = 0;
  let tpCount = 0;
  let strongRecoveryAfterSl = false;

  for (const trade of dayTrades) {
    const rawResultR = trade.resultR !== null ? Number(trade.resultR) : 0;
    if (!Number.isFinite(rawResultR)) continue;
    const resultR = resultRForDailyStats(
      trade.closeReason,
      rawResultR,
      trade.rrPreset,
      settings.dailyProfitLimitR,
    );
    sumR += resultR;
    if (trade.closeReason === "sl") slCount += 1;
    if (trade.closeReason === "tp") {
      tpCount += 1;
      if (isStrongTakeProfit(resultR) && slCount > 0) {
        strongRecoveryAfterSl = true;
      }
    }
  }

  await replaceDailyStats(dayKey, {
    sumR,
    tradesCount: dayTrades.length,
    slCount,
    tpCount,
    strongRecoveryAfterSl,
  });

  const blocks: Block[] = evaluateDailyLimitBlocks(
    now,
    { sumR, slCount, tpCount, strongRecoveryAfterSl },
    settings,
  );
  const lastClosedAt = dayTrades.length > 0 ? dayTrades[dayTrades.length - 1]!.closedAt : null;
  const cooldownBlock = evaluateCooldownBlock(
    now,
    lastClosedAt ? new Date(lastClosedAt) : null,
    settings.cooldownMinutes,
  );
  if (cooldownBlock) {
    blocks.push(cooldownBlock);
  }
  await replaceManagedLocks(blocks);

  return {
    dayKey,
    tradesCount: dayTrades.length,
    sumR,
    tradesFixed,
    lockTypes: blocks.map((b) => b.type),
  };
}

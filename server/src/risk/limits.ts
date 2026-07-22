import { getNextResetAt } from "./tradingDay.js";

export type BlockType =
  | "cooldown"
  | "daily_loss"
  | "daily_profit"
  | "daily_stop_losses"
  | "daily_take_profits"
  | "daily_recovery_after_sl";

export type Block = {
  type: BlockType;
  reason: string;
  until: Date;
};

export type RiskLimitsConfig = {
  cooldownMinutes: number;
  /** Отрицательное число, например -2. */
  dailyLossLimitR: number;
  /** Положительное число, например 3. */
  dailyProfitLimitR: number;
  resetHour: number;
  tzOffsetMinutes: number;
};

export type DailyLimitCounters = {
  sumR: number;
  slCount: number;
  tpCount: number;
  /** Был стоп, а после него — тейк с результатом ≥ STRONG_TP_MIN_R. */
  strongRecoveryAfterSl: boolean;
};

/**
 * Сколько сделок за день, закрытых по стопу, блокируют торговлю до следующего дня —
 * независимо от суммы R и от того, шли эти сделки подряд или нет.
 */
export const DAILY_STOP_LOSS_LIMIT = 2;

/**
 * Сколько тейков за день достаточно, чтобы зафиксировать результат и остановиться —
 * независимо от суммы R (например, два тейка 1:1 дают только +2R, но день уже «удался»).
 */
export const DAILY_TAKE_PROFIT_LIMIT = 2;

/**
 * Минимальный результат тейка (в R), который после предшествующего стопа закрывает день.
 * 2R = пресет 1:2 и выше.
 */
export const STRONG_TP_MIN_R = 2;

/**
 * Дневные лимиты считаются по сумме результатов всех закрытых сделок дня (−2R/+3R), а
 * также по отдельным счётчикам исходов (стопы, тейки, сильный откуп после стопа).
 *
 * Допуск 0.2R на стороне прибыли: комиссии BingX + слиппаж fill могут съесть
 * 0.05–0.15R у тейка 1:3, из-за чего sumR≈2.85 не дотягивал до порога 3.0.
 */
const LIMIT_EPSILON = 0.2;

/** Тейк считается «сильным» (1:2+), если resultR почти достиг STRONG_TP_MIN_R. */
export function isStrongTakeProfit(resultR: number): boolean {
  return resultR >= STRONG_TP_MIN_R - LIMIT_EPSILON;
}

export function evaluateDailyLimitBlocks(
  now: Date,
  counters: DailyLimitCounters,
  config: RiskLimitsConfig,
): Block[] {
  const blocks: Block[] = [];
  const until = getNextResetAt(now, config.resetHour, config.tzOffsetMinutes);

  if (counters.sumR <= config.dailyLossLimitR) {
    blocks.push({
      type: "daily_loss",
      reason: `Дневной лимит убытка (${config.dailyLossLimitR}R) достигнут — торговля возобновится после сброса дня`,
      until,
    });
  }
  if (counters.sumR >= config.dailyProfitLimitR - LIMIT_EPSILON) {
    blocks.push({
      type: "daily_profit",
      reason: `Дневная цель прибыли (+${config.dailyProfitLimitR}R) достигнута — торговля возобновится после сброса дня`,
      until,
    });
  }
  if (counters.slCount >= DAILY_STOP_LOSS_LIMIT) {
    blocks.push({
      type: "daily_stop_losses",
      reason: `${counters.slCount} сделки за день закрыты по стопу — торговля возобновится после сброса дня`,
      until,
    });
  }
  if (counters.tpCount >= DAILY_TAKE_PROFIT_LIMIT) {
    blocks.push({
      type: "daily_take_profits",
      reason: `${counters.tpCount} сделки за день закрыты по тейку — достаточно на сегодня, торговля возобновится после сброса дня`,
      until,
    });
  }
  if (counters.strongRecoveryAfterSl) {
    blocks.push({
      type: "daily_recovery_after_sl",
      reason: `После стопа закрыт тейк ≥ ${STRONG_TP_MIN_R}R — день удался, торговля возобновится после сброса дня`,
      until,
    });
  }
  return blocks;
}

/** Кулдаун после ЛЮБОЙ закрытой сделки — антиовертрейдинг, независимо от результата. */
export function evaluateCooldownBlock(
  now: Date,
  lastTradeClosedAt: Date | null,
  cooldownMinutes: number,
): Block | null {
  if (!lastTradeClosedAt) return null;
  const until = new Date(lastTradeClosedAt.getTime() + cooldownMinutes * 60_000);
  if (until <= now) return null;
  return {
    type: "cooldown",
    reason: "Пауза после сделки — перерыв помогает не пересиживать в рынке",
    until,
  };
}

/** При нескольких активных блокировках действует самая длинная (docs/RISK_ENGINE.md). */
export function pickEffectiveBlock(blocks: Block[]): Block | null {
  if (blocks.length === 0) return null;
  return blocks.reduce((longest, current) => (current.until > longest.until ? current : longest));
}

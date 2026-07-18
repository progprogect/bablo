import { getNextResetAt } from "./tradingDay.js";

export type BlockType = "cooldown" | "daily_loss" | "daily_profit" | "daily_stop_losses";

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

/**
 * Сколько сделок за день, закрытых по стопу, блокируют торговлю до следующего дня —
 * независимо от суммы R и от того, шли эти сделки подряд или нет.
 */
export const DAILY_STOP_LOSS_LIMIT = 2;

/**
 * Дневные лимиты считаются по сумме результатов всех закрытых сделок дня (-2R/+3R), а
 * также отдельно — по количеству сделок, закрытых именно по стопу (см. DAILY_STOP_LOSS_LIMIT).
 *
 * Допуск 0.05R на каждую сторону нужен, чтобы незначительный слиппаж при исполнении
 * TP/SL (fill по чуть худшей цене, чем стоп-уровень) не приводил к тому, что сделка,
 * давшая практически ровно +3R или -2R, не запускала нужный блок из-за floating-point
 * разницы в пределах 0.01–0.04R.
 */
const LIMIT_EPSILON = 0.05;

export function evaluateDailyLimitBlocks(
  now: Date,
  dailySumR: number,
  dailySlCount: number,
  config: RiskLimitsConfig,
): Block[] {
  const blocks: Block[] = [];
  const until = getNextResetAt(now, config.resetHour, config.tzOffsetMinutes);

  if (dailySumR <= config.dailyLossLimitR) {
    blocks.push({
      type: "daily_loss",
      reason: `Дневной лимит убытка (${config.dailyLossLimitR}R) достигнут — торговля возобновится после сброса дня`,
      until,
    });
  }
  if (dailySumR >= config.dailyProfitLimitR - LIMIT_EPSILON) {
    blocks.push({
      type: "daily_profit",
      reason: `Дневная цель прибыли (+${config.dailyProfitLimitR}R) достигнута — торговля возобновится после сброса дня`,
      until,
    });
  }
  if (dailySlCount >= DAILY_STOP_LOSS_LIMIT) {
    blocks.push({
      type: "daily_stop_losses",
      reason: `${dailySlCount} сделки за день закрыты по стопу — торговля возобновится после сброса дня`,
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

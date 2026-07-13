import { getNextResetAt } from "./tradingDay.js";

export type BlockType = "cooldown" | "daily_loss" | "daily_profit";

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

/** Дневные лимиты (-2R/+3R) считаются по сумме результатов всех закрытых сделок дня. */
export function evaluateDailyLimitBlocks(now: Date, dailySumR: number, config: RiskLimitsConfig): Block[] {
  const blocks: Block[] = [];
  const until = getNextResetAt(now, config.resetHour, config.tzOffsetMinutes);

  if (dailySumR <= config.dailyLossLimitR) {
    blocks.push({
      type: "daily_loss",
      reason: `Дневной лимит убытка (${config.dailyLossLimitR}R) достигнут — торговля возобновится после сброса дня`,
      until,
    });
  }
  if (dailySumR >= config.dailyProfitLimitR) {
    blocks.push({
      type: "daily_profit",
      reason: `Дневная цель прибыли (+${config.dailyProfitLimitR}R) достигнута — торговля возобновится после сброса дня`,
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

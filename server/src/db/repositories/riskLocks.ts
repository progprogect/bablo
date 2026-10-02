import { gt, inArray } from "drizzle-orm";
import { getDb } from "../client.js";
import { riskLocks } from "../schema.js";
import type { Block, BlockType } from "../../risk/limits.js";

export type RiskLockRow = typeof riskLocks.$inferSelect;

const MANAGED_TYPES: BlockType[] = [
  "cooldown",
  "daily_loss",
  "daily_profit",
  "daily_stop_losses",
  "stop_chain",
  "daily_take_profits",
  "daily_strong_tp",
  "daily_mixed_outcomes",
  "asset_sl_today",
];

/**
 * Типы, которых в коде больше нет: удаляются вместе с управляемыми, чтобы после
 * переименования правила старая строка не осталась в таблице навсегда.
 */
const RETIRED_TYPES: string[] = ["daily_recovery_after_sl"];

export async function listActiveLocks(now: Date = new Date()): Promise<RiskLockRow[]> {
  const db = getDb();
  return db.select().from(riskLocks).where(gt(riskLocks.until, now));
}

/**
 * Добавляет ОДИН лок, не трогая остальные — для блокировок, которые не пересобираются
 * расчётом (пауза «не в ресурсе»: её ставит ответ пользователя, а не состояние дня).
 * Такие типы намеренно не входят в MANAGED_TYPES, иначе replaceManagedLocks их сотрёт.
 */
export async function createLock(block: Block): Promise<void> {
  const db = getDb();
  await db.insert(riskLocks).values({
    type: block.type,
    reason: block.reason,
    until: block.until,
    symbol: block.symbol ?? null,
  });
}

/**
 * Полностью пересобирает управляемые типы блокировок из свежего расчёта чистой
 * risk-логики. Вызывается один раз после закрытия сделки — гарантирует отсутствие
 * рассинхронизации со старыми записями.
 */
export async function replaceManagedLocks(blocks: Block[]): Promise<void> {
  const db = getDb();
  await db.delete(riskLocks).where(inArray(riskLocks.type, [...MANAGED_TYPES, ...RETIRED_TYPES]));
  if (blocks.length === 0) {
    return;
  }
  await db.insert(riskLocks).values(
    blocks.map((b) => ({
      type: b.type,
      reason: b.reason,
      until: b.until,
      symbol: b.symbol ?? null,
    })),
  );
}

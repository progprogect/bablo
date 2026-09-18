import { BingXApiError, getWithdrawHistory } from "../bingx/client.js";
import { createEquityAdjustment } from "../db/repositories/equityAdjustments.js";
import {
  createWithdrawalRequirement,
  listLevelWithdrawals,
  listPendingWithdrawals,
  markWithdrawalDone,
  type LevelWithdrawalRow,
} from "../db/repositories/levelWithdrawals.js";
import { listRiskLevelDefs } from "../db/repositories/riskLevels.js";
import { getBingxCredentials, getRiskSettings } from "../db/repositories/settings.js";
import { getLevelDef } from "../risk/ladder.js";
import { getLocalDateKey } from "../risk/tradingDay.js";
import {
  checkWithdrawalAmount,
  completedLevels,
  matchWithdrawals,
  withdrawalBlockReason,
  type ExternalWithdrawal,
  type PendingWithdrawal,
} from "../risk/withdrawals.js";

/**
 * I/O-обвязка правила вывода прибыли по уровням (risk/withdrawals.ts — чистая часть):
 * создание требований при переходе уровня, сверка с историей выводов BingX, ручное
 * подтверждение и сводка для UI.
 */

export class WithdrawalError extends Error {}

function toPending(row: LevelWithdrawalRow): PendingWithdrawal & { createdAtMs: number } {
  return {
    id: row.id,
    level: row.level,
    requiredUsd: Number(row.requiredUsd),
    createdAtMs: row.createdAt.getTime(),
  };
}

/**
 * Требования за уровни, пройденные при переходе previousLevel → nextLevel. Вызывается
 * после обновления риск-состояния (risk/service.ts): сумма вывода — это 1R ПРОЙДЕННОГО
 * уровня, поэтому её берём из лестницы по старому номеру, а не по новому.
 */
export async function createRequirementsForLevelUp(
  previousLevel: number,
  nextLevel: number,
  at: Date = new Date(),
): Promise<void> {
  const levels = completedLevels(previousLevel, nextLevel);
  if (levels.length === 0) return;
  const defs = await listRiskLevelDefs();
  for (const level of levels) {
    const def = getLevelDef(defs, level);
    if (!def || !(def.riskUsd > 0)) continue;
    await createWithdrawalRequirement({ level, requiredUsd: def.riskUsd, createdAt: at });
  }
}

/*
 * Стартового требования «за уже пройденный уровень» намеренно НЕТ (решение пользователя
 * от 18.09.2026, изменено в тот же день): правило действует только со СЛЕДУЮЩЕГО
 * повышения уровня. Иначе сразу после выката торговля оказывалась закрытой за уровень,
 * который был пройден до появления правила. Требования создаёт только
 * createRequirementsForLevelUp — на фактическом переходе уровня.
 */

export type WithdrawalView = {
  id: number;
  level: number;
  requiredUsd: number;
  withdrawnUsd: number | null;
  withdrawnAt: string | null;
  source: string | null;
};

export type WithdrawalsState = {
  /** Незакрытые требования — пока они есть, открытие сделок заблокировано. */
  pending: { id: number; level: number; requiredUsd: number }[];
  /** Текст блокировки для UI; null — выводить нечего. */
  blockReason: string | null;
  /** Сколько реальных денег уже снято с биржи. */
  totalWithdrawnUsd: number;
  history: WithdrawalView[];
};

function toView(row: LevelWithdrawalRow): WithdrawalView {
  return {
    id: row.id,
    level: row.level,
    requiredUsd: Number(row.requiredUsd),
    withdrawnUsd: row.withdrawnUsd !== null ? Number(row.withdrawnUsd) : null,
    withdrawnAt: row.withdrawnAt ? row.withdrawnAt.toISOString() : null,
    source: row.source,
  };
}

export async function getWithdrawalsState(): Promise<WithdrawalsState> {
  const rows = await listLevelWithdrawals();
  const pending = rows
    .filter((row) => row.withdrawnAt === null)
    .map((row) => ({ id: row.id, level: row.level, requiredUsd: Number(row.requiredUsd) }));
  const totalWithdrawnUsd = rows.reduce(
    (sum, row) => sum + (row.withdrawnUsd !== null ? Number(row.withdrawnUsd) : 0),
    0,
  );
  return {
    pending,
    blockReason: withdrawalBlockReason(pending),
    totalWithdrawnUsd,
    history: rows.map(toView),
  };
}

/** Незакрытые требования для риск-гейта — без истории и лишних полей. */
export async function listPendingWithdrawalRequirements(): Promise<PendingWithdrawal[]> {
  const rows = await listPendingWithdrawals();
  return rows.map((row) => ({ id: row.id, level: row.level, requiredUsd: Number(row.requiredUsd) }));
}

/**
 * Вывод уменьшает депозит — записываем его в корректировки баланса, иначе месячный %
 * посчитает вывод торговым убытком (history/monthlyStats.ts).
 */
async function recordEquityAdjustment(amountUsd: number, at: Date, level: number): Promise<number | null> {
  try {
    const settings = await getRiskSettings();
    const row = await createEquityAdjustment({
      date: getLocalDateKey(at, settings.tzOffsetMinutes),
      amountUsd: -Math.abs(amountUsd),
      note: `Вывод прибыли за уровень ${level}`,
    });
    return row.id;
  } catch {
    // Корректировка — вторичная бухгалтерия: её сбой не должен мешать снять блокировку.
    return null;
  }
}

/** Ручное подтверждение вывода: сумма должна совпасть с требуемой до цента. */
export async function confirmWithdrawalManually(input: {
  id: number;
  amountUsd: number;
  at?: Date;
}): Promise<WithdrawalsState> {
  const pendingRows = await listPendingWithdrawals();
  const row = pendingRows.find((candidate) => candidate.id === input.id);
  if (!row) {
    throw new WithdrawalError("Требование вывода не найдено или уже закрыто");
  }
  const check = checkWithdrawalAmount(toPending(row), input.amountUsd);
  if (!check.ok) {
    throw new WithdrawalError(check.reason);
  }

  const at = input.at ?? new Date();
  const adjustmentId = await recordEquityAdjustment(input.amountUsd, at, row.level);
  await markWithdrawalDone(row.id, {
    withdrawnUsd: input.amountUsd,
    withdrawnAt: at,
    source: "manual",
    equityAdjustmentId: adjustmentId,
  });
  return getWithdrawalsState();
}

export type BingxWithdrawalCheck = {
  /** Сколько выводов в USDT вернула биржа. */
  found: number;
  /** Сколько требований закрылось этой сверкой. */
  matched: number;
  /** Текст ошибки BingX, если история недоступна (например, у ключа нет прав кошелька). */
  error: string | null;
  state: WithdrawalsState;
};

/**
 * Сверка с историей выводов BingX. Эндпоинт относится к КОШЕЛЬКУ: если у ключа нет прав
 * на его чтение, BingX вернёт ошибку — тогда отдаём её текстом, требование остаётся
 * открытым и закрывается ручным подтверждением. Разовый запрос по кнопке, не поллинг.
 */
export async function checkBingxWithdrawals(): Promise<BingxWithdrawalCheck> {
  const pendingRows = await listPendingWithdrawals();
  if (pendingRows.length === 0) {
    return { found: 0, matched: 0, error: null, state: await getWithdrawalsState() };
  }

  const credentials = await getBingxCredentials();
  if (!credentials) {
    return { found: 0, matched: 0, error: "Ключи BingX не настроены", state: await getWithdrawalsState() };
  }

  const oldest = pendingRows.reduce(
    (min, row) => Math.min(min, row.createdAt.getTime()),
    Number.POSITIVE_INFINITY,
  );
  let records: ExternalWithdrawal[];
  try {
    const history = await getWithdrawHistory(credentials, { startTime: oldest });
    records = history
      .filter((entry) => entry.coin.toUpperCase() === "USDT")
      .map((entry) => ({ id: entry.id, amountUsd: entry.amount, atMs: entry.applyTimeMs }));
  } catch (error) {
    const message =
      error instanceof BingXApiError
        ? `BingX: ${error.message}`
        : "Не удалось получить историю выводов BingX";
    return { found: 0, matched: 0, error: message, state: await getWithdrawalsState() };
  }

  const usedIds = (await listLevelWithdrawals())
    .map((row) => row.externalId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const pairs = matchWithdrawals(pendingRows.map(toPending), records, usedIds);

  for (const pair of pairs) {
    const row = pendingRows.find((candidate) => candidate.id === pair.pendingId);
    if (!row) continue;
    const at = pair.record.atMs !== null ? new Date(pair.record.atMs) : new Date();
    const adjustmentId = await recordEquityAdjustment(pair.record.amountUsd, at, row.level);
    await markWithdrawalDone(row.id, {
      withdrawnUsd: pair.record.amountUsd,
      withdrawnAt: at,
      source: "bingx",
      externalId: pair.record.id,
      equityAdjustmentId: adjustmentId,
    });
  }

  return { found: records.length, matched: pairs.length, error: null, state: await getWithdrawalsState() };
}

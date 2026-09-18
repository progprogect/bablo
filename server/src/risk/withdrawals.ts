/**
 * Вывод прибыли по уровням (правило пользователя от 18.09.2026).
 *
 * Идея: трейдинг имеет смысл, когда прибыль превращается в реальные деньги. Поэтому
 * каждое прохождение уровня обязывает вывести с биржи ровно ту сумму, которой равен 1R
 * пройденного уровня (прошла 6-й уровень с 1R = 60$ → вывести ровно 60$). Пока вывод не
 * сделан, открытие сделок заблокировано — это единственное правило в приложении, которое
 * блокирует торговлю не по риску, а по дисциплине вывода прибыли.
 *
 * Чистая логика: суммы, сверка факта с требованием и текст блокировки. Состояние
 * (таблица level_withdrawals), запросы к BingX и создание корректировки баланса — в
 * withdrawals/service.ts.
 */

/**
 * Совпадение суммы проверяется СТРОГО ДО ЦЕНТА (решение пользователя от 18.09.2026):
 * вывел меньше или больше — требование не закрыто. Сравниваем целые центы, чтобы
 * двоичная дробь (60.1 - 60.1 ≠ 0) не мешала.
 */
export function toCents(amountUsd: number): number {
  return Math.round(amountUsd * 100);
}

export function amountsMatch(requiredUsd: number, actualUsd: number): boolean {
  return toCents(requiredUsd) === toCents(actualUsd);
}

/** Незакрытое требование вывода. */
export type PendingWithdrawal = {
  id: number;
  level: number;
  requiredUsd: number;
};

export type WithdrawalMatch =
  | { ok: true }
  | { ok: false; reason: string };

/** Подходит ли сумма под требование — с понятным текстом отказа для UI. */
export function checkWithdrawalAmount(
  pending: PendingWithdrawal,
  actualUsd: number,
): WithdrawalMatch {
  if (!Number.isFinite(actualUsd) || actualUsd <= 0) {
    return { ok: false, reason: "Сумма вывода должна быть больше нуля" };
  }
  if (!amountsMatch(pending.requiredUsd, actualUsd)) {
    const diff = actualUsd - pending.requiredUsd;
    const direction = diff > 0 ? "больше" : "меньше";
    return {
      ok: false,
      reason:
        `За уровень ${pending.level} нужно вывести ровно ${formatUsd(pending.requiredUsd)} USDT, ` +
        `а указано ${formatUsd(actualUsd)} USDT — на ${formatUsd(Math.abs(diff))} ${direction}`,
    };
  }
  return { ok: true };
}

export function formatUsd(amountUsd: number): string {
  return amountUsd.toFixed(2);
}

/** Текст блокировки открытия сделок, пока прибыль не выведена. */
export function withdrawalBlockReason(pending: PendingWithdrawal[]): string | null {
  if (pending.length === 0) return null;
  if (pending.length === 1) {
    const [only] = pending as [PendingWithdrawal];
    return (
      `Пройден уровень ${only.level} — выведите с биржи ровно ${formatUsd(only.requiredUsd)} USDT, ` +
      "чтобы продолжить торговать"
    );
  }
  const total = pending.reduce((sum, entry) => sum + entry.requiredUsd, 0);
  const levels = pending.map((entry) => entry.level).join(", ");
  return (
    `Не выведена прибыль за уровни ${levels} — всего ${formatUsd(total)} USDT. ` +
    "Выведите каждую сумму отдельно, чтобы продолжить торговать"
  );
}

/** Вывод, найденный в истории биржи. */
export type ExternalWithdrawal = {
  id: string;
  amountUsd: number;
  /** Время вывода в мс; null — биржа не дала времени, такой вывод не засчитываем. */
  atMs: number | null;
};

export type WithdrawalMatchPair = { pendingId: number; record: ExternalWithdrawal };

/**
 * Сопоставляет выводы с биржи требованиям: сумма — строго до цента, вывод должен быть
 * сделан ПОСЛЕ появления требования (иначе старый вывод закрыл бы новый уровень), один
 * вывод закрывает максимум одно требование. Требования разбираются от старых к новым.
 */
export function matchWithdrawals(
  pending: (PendingWithdrawal & { createdAtMs: number })[],
  records: ExternalWithdrawal[],
  usedExternalIds: Iterable<string> = [],
): WithdrawalMatchPair[] {
  const used = new Set(usedExternalIds);
  const pairs: WithdrawalMatchPair[] = [];
  const sortedPending = [...pending].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const sortedRecords = [...records].sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));

  for (const requirement of sortedPending) {
    const record = sortedRecords.find(
      (candidate) =>
        candidate.id !== "" &&
        !used.has(candidate.id) &&
        candidate.atMs !== null &&
        candidate.atMs >= requirement.createdAtMs &&
        amountsMatch(requirement.requiredUsd, candidate.amountUsd),
    );
    if (!record) continue;
    used.add(record.id);
    pairs.push({ pendingId: requirement.id, record });
  }
  return pairs;
}

/**
 * Какой уровень считается пройденным при переходе currentLevel → nextLevel: все уровни
 * от текущего до предыдущего перед новым. Обычно это ровно один уровень (перескок через
 * два невозможен: одна сделка не даёт 10R), но правило описано общим случаем.
 */
export function completedLevels(previousLevel: number, nextLevel: number): number[] {
  const levels: number[] = [];
  for (let level = previousLevel; level < nextLevel; level += 1) {
    levels.push(level);
  }
  return levels;
}

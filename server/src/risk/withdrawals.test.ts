import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amountsMatch,
  checkWithdrawalAmount,
  completedLevels,
  matchWithdrawals,
  requiredWithdrawalUsd,
  withdrawalBlockReason,
  withdrawalMultiplierForLevel,
} from "./withdrawals.js";

const pending = { id: 1, level: 6, requiredUsd: 60 };

test("amountsMatch: сверка строго до цента", () => {
  assert.equal(amountsMatch(60, 60), true);
  assert.equal(amountsMatch(60, 60.004), true); // округление до цента
  assert.equal(amountsMatch(60, 60.01), false);
  assert.equal(amountsMatch(60, 59.99), false);
  assert.equal(amountsMatch(60, 61), false);
  assert.equal(amountsMatch(60, 59), false);
  // Двоичная дробь не должна ломать сравнение.
  assert.equal(amountsMatch(60.1, 60.1), true);
});

test("checkWithdrawalAmount: ровная сумма закрывает требование", () => {
  assert.deepEqual(checkWithdrawalAmount(pending, 60), { ok: true });
});

test("checkWithdrawalAmount: меньше — отказ с объяснением", () => {
  const result = checkWithdrawalAmount(pending, 59);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /ровно 60.00 USDT/);
  assert.match(result.ok === false ? result.reason : "", /на 1.00 меньше/);
});

test("checkWithdrawalAmount: больше — тоже отказ", () => {
  const result = checkWithdrawalAmount(pending, 61.5);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /на 1.50 больше/);
});

test("checkWithdrawalAmount: ноль и мусор не проходят", () => {
  assert.equal(checkWithdrawalAmount(pending, 0).ok, false);
  assert.equal(checkWithdrawalAmount(pending, Number.NaN).ok, false);
});

test("withdrawalBlockReason: нет требований — нет блокировки", () => {
  assert.equal(withdrawalBlockReason([]), null);
});

test("withdrawalBlockReason: одно требование — сумма и уровень в тексте", () => {
  assert.match(withdrawalBlockReason([pending]) ?? "", /уровень 6.*ровно 60.00 USDT/);
});

test("withdrawalBlockReason: несколько требований — перечисляем и суммируем", () => {
  const reason =
    withdrawalBlockReason([pending, { id: 2, level: 7, requiredUsd: 70 }]) ?? "";
  assert.match(reason, /уровни 6, 7/);
  assert.match(reason, /всего 130.00 USDT/);
});

test("completedLevels: обычный переход — один пройденный уровень", () => {
  assert.deepEqual(completedLevels(6, 7), [6]);
});

test("completedLevels: перескок через несколько уровней — все пройденные", () => {
  assert.deepEqual(completedLevels(6, 9), [6, 7, 8]);
});

test("completedLevels: уровень не изменился — пусто", () => {
  assert.deepEqual(completedLevels(6, 6), []);
});

// --- Сопоставление выводов из истории биржи ---

const req = (id: number, level: number, requiredUsd: number, createdAtMs: number) => ({
  id,
  level,
  requiredUsd,
  createdAtMs,
});

test("matchWithdrawals: вывод на ровную сумму после требования — засчитан", () => {
  const pairs = matchWithdrawals(
    [req(1, 6, 60, 1_000)],
    [{ id: "w1", amountUsd: 60, atMs: 2_000 }],
  );
  assert.deepEqual(pairs.map((p) => [p.pendingId, p.record.id]), [[1, "w1"]]);
});

test("matchWithdrawals: вывод ДО появления требования не засчитывается", () => {
  const pairs = matchWithdrawals(
    [req(1, 6, 60, 5_000)],
    [{ id: "w1", amountUsd: 60, atMs: 1_000 }],
  );
  assert.deepEqual(pairs, []);
});

test("matchWithdrawals: сумма не совпала до цента — не засчитывается", () => {
  const pairs = matchWithdrawals(
    [req(1, 6, 60, 1_000)],
    [{ id: "w1", amountUsd: 59.99, atMs: 2_000 }],
  );
  assert.deepEqual(pairs, []);
});

test("matchWithdrawals: один вывод не закрывает два требования", () => {
  const pairs = matchWithdrawals(
    [req(1, 6, 60, 1_000), req(2, 6, 60, 1_500)],
    [{ id: "w1", amountUsd: 60, atMs: 2_000 }],
  );
  assert.deepEqual(pairs.map((p) => p.pendingId), [1]);
});

test("matchWithdrawals: уже использованный вывод пропускаем", () => {
  const pairs = matchWithdrawals(
    [req(1, 6, 60, 1_000)],
    [{ id: "w1", amountUsd: 60, atMs: 2_000 }],
    ["w1"],
  );
  assert.deepEqual(pairs, []);
});

test("matchWithdrawals: вывод без времени не засчитываем", () => {
  const pairs = matchWithdrawals(
    [req(1, 6, 60, 1_000)],
    [{ id: "w1", amountUsd: 60, atMs: null }],
  );
  assert.deepEqual(pairs, []);
});

test("matchWithdrawals: два требования и два подходящих вывода — разбираются по порядку", () => {
  const pairs = matchWithdrawals(
    [req(1, 6, 60, 1_000), req(2, 7, 70, 3_000)],
    [
      { id: "w2", amountUsd: 70, atMs: 4_000 },
      { id: "w1", amountUsd: 60, atMs: 2_000 },
    ],
  );
  assert.deepEqual(pairs.map((p) => [p.pendingId, p.record.id]), [[1, "w1"], [2, "w2"]]);
});

// --- Множитель вывода (19.09.2026): 2R, а с 22-го уровня 3R ---

test("withdrawalMultiplierForLevel: до 22 уровня — 2R, с 22-го — 3R", () => {
  assert.equal(withdrawalMultiplierForLevel(1), 2);
  assert.equal(withdrawalMultiplierForLevel(21), 2);
  assert.equal(withdrawalMultiplierForLevel(22), 3);
  assert.equal(withdrawalMultiplierForLevel(50), 3);
});

test("requiredWithdrawalUsd: сумма = 1R уровня × множитель", () => {
  assert.equal(requiredWithdrawalUsd(6, 60), 120); // прошла 6-й уровень (1R = 60$) → 120$
  assert.equal(requiredWithdrawalUsd(21, 280), 560);
  assert.equal(requiredWithdrawalUsd(22, 300), 900); // с 22-го — уже 3R
  assert.equal(requiredWithdrawalUsd(50, 1000), 3000);
});

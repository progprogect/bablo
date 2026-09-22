import assert from "node:assert/strict";
import test from "node:test";
import {
  decideManualHourReview,
  localMonthKey,
  monthKeyOf,
  type ManualHourBlockState,
  type MonthWinrate,
} from "./hourBlockReview.js";

const MSK = 180; // UTC+3 — таймзона риск-плана по умолчанию

function month(key: string, winRate: number, totalTrades = 10): MonthWinrate {
  const [year, m] = key.split("-").map(Number);
  return { year: year!, month: m!, totalTrades, winRate };
}

/** Блокировка часа 9 из миграции 0018: база — сентябрь, проверка — с октября. */
function block(overrides: Partial<ManualHourBlockState> = {}): ManualHourBlockState {
  return { hour: 9, baselineMonth: "2026-09", fromMonth: "2026-10", reviewed: false, ...overrides };
}

/** Момент внутри месяца в таймзоне риск-плана. */
function at(key: string, day = 15): Date {
  const [year, m] = key.split("-").map(Number);
  return new Date(Date.UTC(year!, m! - 1, day, 12) - MSK * 60_000);
}

function decide(blocks: ManualHourBlockState[], months: MonthWinrate[], now: Date) {
  return decideManualHourReview({ blocks, months, now, tzOffsetMinutes: MSK });
}

test("ключ месяца считается в таймзоне риск-плана, а не в UTC", () => {
  assert.equal(monthKeyOf(2026, 9), "2026-09");
  assert.equal(monthKeyOf(2026, 10), "2026-10");
  // 30.09 23:30 UTC — это уже 01.10 02:30 по МСК, то есть октябрь.
  assert.equal(localMonthKey(new Date("2026-09-30T23:30:00Z"), MSK), "2026-10");
  // 01.10 00:30 UTC — ещё 01.10 03:30 по МСК, тоже октябрь.
  assert.equal(localMonthKey(new Date("2026-10-01T00:30:00Z"), MSK), "2026-10");
  // 31.10 20:00 UTC = 31.10 23:00 МСК — октябрь ещё не закончился.
  assert.equal(localMonthKey(new Date("2026-10-31T20:00:00Z"), MSK), "2026-10");
});

test("пока месяц проверки не завершился, решения нет", () => {
  const months = [month("2026-09", 0.4), month("2026-10", 0.9)];
  // Идёт октябрь: его винрейт ещё не итоговый, трогать блокировку рано.
  const decision = decide([block()], months, at("2026-10", 20));
  assert.deepEqual(decision.toUnblock, []);
  assert.deepEqual(decision.toMarkReviewed, []);
});

test("винрейт вырос — час остаётся закрытым, проверка помечается выполненной", () => {
  const months = [month("2026-09", 0.4), month("2026-10", 0.55)];
  const decision = decide([block()], months, at("2026-11", 1));
  assert.deepEqual(decision.toUnblock, []);
  assert.deepEqual(decision.toMarkReviewed, [9]);
});

test("винрейт не вырос — час открывается", () => {
  const months = [month("2026-09", 0.6), month("2026-10", 0.42)];
  assert.deepEqual(decide([block()], months, at("2026-11", 1)).toUnblock, [9]);
});

test("винрейт ровно такой же — час открывается (равен = не вырос)", () => {
  const months = [month("2026-09", 0.5), month("2026-10", 0.5)];
  const decision = decide([block()], months, at("2026-11", 1));
  assert.deepEqual(decision.toUnblock, [9]);
  assert.deepEqual(decision.toMarkReviewed, []);
});

test("равенство не ломается на шуме float", () => {
  // 3/7 и 6/14 — одно и то же число, посчитанное разными делениями.
  const months = [month("2026-09", 3 / 7), month("2026-10", 6 / 14)];
  assert.deepEqual(decide([block()], months, at("2026-11", 1)).toUnblock, [9]);
});

test("месяц проверки без сделок — проверка переезжает на следующий, база прежняя", () => {
  const emptyOctober = [month("2026-09", 0.4), month("2026-10", 0.9, 0)];
  // Ноябрь ещё идёт: сравнивать не с чем, час остаётся закрытым.
  assert.deepEqual(decide([block()], emptyOctober, at("2026-11", 10)).toUnblock, []);
  assert.deepEqual(decide([block()], emptyOctober, at("2026-11", 10)).toMarkReviewed, []);

  // Ноябрь закончился и в нём была торговля — сравнивается ОН, но всё ещё с сентябрём.
  const withNovember = [...emptyOctober, month("2026-11", 0.3)];
  assert.deepEqual(decide([block()], withNovember, at("2026-12", 1)).toUnblock, [9]);
});

test("месяца проверки вообще нет в статистике — ждём, а не открываем", () => {
  const decision = decide([block()], [month("2026-09", 0.4)], at("2026-11", 1));
  assert.deepEqual(decision.toUnblock, []);
  assert.deepEqual(decision.toMarkReviewed, []);
});

test("базы для сравнения нет или она пустая — час остаётся закрытым навсегда", () => {
  const noBaseline = [month("2026-10", 0.1)];
  assert.deepEqual(decide([block()], noBaseline, at("2026-11", 1)).toUnblock, []);

  const emptyBaseline = [month("2026-09", 0, 0), month("2026-10", 0.1)];
  assert.deepEqual(decide([block()], emptyBaseline, at("2026-11", 1)).toUnblock, []);
});

test("проверка разовая: уже проверенный час больше не оценивается", () => {
  const months = [month("2026-09", 0.9), month("2026-10", 0.1)];
  // Винрейт упал — по правилу час бы открылся, но проверка уже состоялась.
  const decision = decide([block({ reviewed: true })], months, at("2026-11", 1));
  assert.deepEqual(decision.toUnblock, []);
  assert.deepEqual(decision.toMarkReviewed, []);
});

test("блокировка без параметров проверки не трогается", () => {
  const months = [month("2026-09", 0.9), month("2026-10", 0.1)];
  const broken = [block({ baselineMonth: null }), block({ hour: 10, fromMonth: null })];
  const decision = decide(broken, months, at("2026-11", 1));
  assert.deepEqual(decision.toUnblock, []);
  assert.deepEqual(decision.toMarkReviewed, []);
});

test("оба часа решаются одинаково — это один эксперимент", () => {
  const months = [month("2026-09", 0.4), month("2026-10", 0.7)];
  const decision = decide([block(), block({ hour: 10 })], months, at("2026-11", 1));
  assert.deepEqual(decision.toMarkReviewed, [9, 10]);
  assert.deepEqual(decision.toUnblock, []);
});

test("решение идемпотентно: повторный вызов на тех же данных даёт то же самое", () => {
  const months = [month("2026-09", 0.6), month("2026-10", 0.42)];
  const now = at("2026-11", 1);
  assert.deepEqual(decide([block()], months, now), decide([block()], months, now));
});

test("более поздние месяцы не подменяют месяц проверки", () => {
  // Октябрь отработан и проверка должна идти по нему, даже если ноябрь уже закрыт
  // и выглядит лучше.
  const months = [month("2026-09", 0.6), month("2026-10", 0.42), month("2026-11", 0.95)];
  assert.deepEqual(decide([block()], months, at("2026-12", 1)).toUnblock, [9]);
});

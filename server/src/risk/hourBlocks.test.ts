import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideHourBlocks,
  nextProfitableHour,
  openHourAfter,
  overallWinrate,
  referenceTradeCount,
  type BlockedHourState,
  type HourOutcome,
} from "./hourBlocks.js";

/**
 * Обёртка над decideHourBlocks для тестов: по умолчанию общий винрейт «не менялся»
 * (проверка гипотезы от 18.09.2026 не мешает старым сценариям), заблокированные часы
 * задаются номерами.
 */
function decide(
  hours: HourOutcome[],
  blocked: (number | BlockedHourState)[] = [],
  overall: { atBlock?: number | null; now?: number | null } = {},
) {
  return decideHourBlocks({
    hours,
    blocked: blocked.map((entry) =>
      typeof entry === "number"
        ? { hour: entry, overallWinrateAtBlock: overall.atBlock ?? null }
        : entry,
    ),
    overallWinrate: overall.now ?? null,
  });
}

const TZ = 180; // UTC+3

function hour(h: number, tpCount: number, total: number): HourOutcome {
  return { hour: h, tpCount, total };
}

/** Локальное время (UTC+3) как реальный момент UTC. */
function at(localHour: number, minutes = 0): Date {
  return new Date(Date.UTC(2026, 8, 12, localHour - 3, minutes, 0));
}

test("referenceTradeCount: максимум сделок среди прибыльных часов (винрейт ≥ 50%)", () => {
  const hours = [
    hour(9, 3, 10), // 30% — не прибыльный, в эталон не идёт, хотя сделок больше всех
    hour(15, 6, 9), // 67% — прибыльный, 9 сделок
    hour(7, 5, 7), // 71% — прибыльный, но сделок меньше
  ];
  assert.equal(referenceTradeCount(hours), 9);
});

test("referenceTradeCount: ровно 50% — тоже прибыльный час", () => {
  assert.equal(referenceTradeCount([hour(8, 1, 2), hour(9, 5, 12)]), 2);
});

test("referenceTradeCount: прибыльных часов нет — эталона нет", () => {
  assert.equal(referenceTradeCount([hour(9, 3, 10), hour(12, 1, 9)]), null);
});

test("decideHourBlocks: пример пользователя — 9ч блокируется, 10ч ещё нет", () => {
  const hours = [
    hour(9, 3, 10), // 30% и сделок больше эталона (10 > 9) → блок
    hour(10, 3, 9), // 33% и сделок не больше эталона (9 = 9) → не блок по обоим условиям
    hour(15, 6, 9), // эталон
  ];
  const decision = decide(hours, []);
  assert.deepEqual(decision.toBlock, [{ hour: 9, tpCount: 3, total: 10, reference: 9 }]);
  assert.deepEqual(decision.toUnblock, []);
  assert.deepEqual(decision.blockedHours, [9]);
  assert.equal(decision.reference, 9);
});

test("decideHourBlocks: винрейт ровно 30% блокирует, 31% — уже нет", () => {
  const base = [hour(15, 6, 9)];
  assert.deepEqual(decide([...base, hour(9, 3, 10)], []).blockedHours, [9]);
  // 4/13 ≈ 30.8% — выше порога
  assert.deepEqual(decide([...base, hour(9, 4, 13)], []).blockedHours, []);
});

test("decideHourBlocks: сделок ровно столько же, сколько у эталона — не блокируем", () => {
  const hours = [hour(15, 6, 9), hour(9, 0, 9)];
  assert.deepEqual(decide(hours, []).blockedHours, []);
});

test("decideHourBlocks: без прибыльных часов не блокируем ничего", () => {
  assert.deepEqual(decide([hour(9, 0, 20), hour(12, 1, 9)], []).blockedHours, []);
});

test("decideHourBlocks: гистерезис — эталон обогнал час, но меньше чем в 1.5 раза", () => {
  // Час 9ч заблокирован на 10 сделках. Эталон вырос до 12: правило блокировки уже не
  // выполняется, но разблокировка наступает только при 15 (10 × 1.5).
  const hours = [hour(9, 3, 10), hour(15, 8, 12)];
  const decision = decide(hours, [9]);
  assert.deepEqual(decision.toBlock, []);
  assert.deepEqual(decision.toUnblock, []);
  assert.deepEqual(decision.blockedHours, [9]);
});

test("decideHourBlocks: эталон вырос в 1.5 раза — час разблокирован", () => {
  const hours = [hour(9, 3, 10), hour(15, 10, 15)];
  const decision = decide(hours, [9]);
  assert.deepEqual(decision.toUnblock, [{ hour: 9, reference: 15 }]);
  assert.deepEqual(decision.blockedHours, []);
});

test("decideHourBlocks: разблокированный час сразу обратно не блокируется", () => {
  // После разблокировки эталон (15) больше сделок часа (10) — условие блокировки
  // «сделок больше эталона» не выполняется, значит качели исключены.
  const hours = [hour(9, 3, 10), hour(15, 10, 15)];
  const afterUnblock = decide(hours, [9]).blockedHours;
  assert.deepEqual(decide(hours, afterUnblock).blockedHours, []);
});

test("decideHourBlocks: час исчез из статистики — блокировка снимается", () => {
  const decision = decide([hour(15, 6, 9)], [9]);
  assert.deepEqual(decision.toUnblock, [{ hour: 9, reference: 9 }]);
  assert.deepEqual(decision.blockedHours, []);
});

test("decideHourBlocks: блокируются все подходящие часы сразу", () => {
  const hours = [hour(9, 3, 10), hour(12, 2, 11), hour(15, 6, 9)];
  assert.deepEqual(decide(hours, []).blockedHours, [9, 12]);
});

test("openHourAfter: час не заблокирован — блокировки нет", () => {
  assert.equal(openHourAfter(at(10, 30), [9], TZ), null);
});

test("openHourAfter: конец текущего заблокированного часа", () => {
  assert.deepEqual(openHourAfter(at(9, 30), [9], TZ), at(10));
});

test("openHourAfter: подряд заблокированные часы схлопываются в одно ожидание", () => {
  assert.deepEqual(openHourAfter(at(9, 15), [9, 10, 11], TZ), at(12));
});

test("openHourAfter: полоса блокировки через полночь", () => {
  // 23ч и 0ч закрыты — ждать до 1:00 следующих суток.
  assert.deepEqual(
    openHourAfter(new Date(Date.UTC(2026, 8, 12, 20, 40)), [23, 0], TZ),
    new Date(Date.UTC(2026, 8, 12, 22, 0)),
  );
});

test("nextProfitableHour: ближайший час с винрейтом ≥ 50% после текущего", () => {
  const hours = [hour(9, 3, 10), hour(15, 6, 9), hour(7, 5, 7)];
  assert.equal(nextProfitableHour(at(9, 5), hours, TZ), 15);
  // После 15ч ближайший прибыльный — уже следующим днём в 7ч.
  assert.equal(nextProfitableHour(at(16, 5), hours, TZ), 7);
});

test("nextProfitableHour: прибыльных часов нет", () => {
  assert.equal(nextProfitableHour(at(9, 5), [hour(9, 3, 10)], TZ), null);
});

// --- Проверка гипотезы (18.09.2026): вырос общий винрейт — час остаётся закрытым ---

test("overallWinrate: доля тейков по всем сделкам", () => {
  const trades = [
    { closedAt: new Date("2026-08-01T10:00:00Z"), isTp: true },
    { closedAt: new Date("2026-08-02T10:00:00Z"), isTp: false },
    { closedAt: new Date("2026-08-03T10:00:00Z"), isTp: true },
    { closedAt: new Date("2026-08-04T10:00:00Z"), isTp: true },
  ];
  assert.equal(overallWinrate(trades), 0.75);
  // Только сделки, закрытые строго раньше момента блокировки — винрейт «тогда».
  assert.equal(overallWinrate(trades, new Date("2026-08-03T00:00:00Z")), 0.5);
  assert.equal(overallWinrate(trades, new Date("2026-07-01T00:00:00Z")), null);
  assert.equal(overallWinrate([]), null);
});

test("decideHourBlocks: винрейт вырос с момента блокировки — час НЕ открываем", () => {
  // Время второго шанса пришло (эталон 15 ≥ 10 × 1.5), но общий винрейт вырос с 0.4 до 0.5.
  const hours = [hour(9, 3, 10), hour(15, 10, 15)];
  const decision = decide(hours, [9], { atBlock: 0.4, now: 0.5 });
  assert.deepEqual(decision.toUnblock, []);
  assert.deepEqual(decision.blockedHours, [9]);
});

test("decideHourBlocks: винрейт не вырос — час открывается как раньше", () => {
  const hours = [hour(9, 3, 10), hour(15, 10, 15)];
  assert.deepEqual(decide(hours, [9], { atBlock: 0.5, now: 0.5 }).blockedHours, []);
  assert.deepEqual(decide(hours, [9], { atBlock: 0.5, now: 0.42 }).blockedHours, []);
});

test("decideHourBlocks: винрейт на момент блокировки неизвестен — правило не мешает", () => {
  const hours = [hour(9, 3, 10), hour(15, 10, 15)];
  assert.deepEqual(decide(hours, [9], { atBlock: null, now: 0.6 }).blockedHours, []);
});

test("decideHourBlocks: выросший винрейт не мешает закрывать новые убыточные часы", () => {
  // 12ч изучен (16 сделок больше эталона 15) и слаб (19% ≤ 30%) — закрываем его.
  const hours = [hour(9, 3, 10), hour(12, 3, 16), hour(15, 10, 15)];
  const decision = decide(hours, [9], { atBlock: 0.4, now: 0.6 });
  assert.deepEqual(decision.toBlock.map((entry) => entry.hour), [12]);
  assert.deepEqual(decision.blockedHours, [9, 12]);
});

test("decideHourBlocks: у каждого часа свой момент блокировки и свой базовый винрейт", () => {
  // 9ч закрыт раньше (винрейт тогда 0.4 — уже вырос), 12ч позже (0.62 — снизился).
  // Оба часа по 10 сделок, эталон 15 — время второго шанса пришло для обоих.
  const hours = [hour(9, 3, 10), hour(12, 2, 10), hour(15, 10, 15)];
  const decision = decideHourBlocks({
    hours,
    blocked: [
      { hour: 9, overallWinrateAtBlock: 0.4 },
      { hour: 12, overallWinrateAtBlock: 0.62 },
    ],
    overallWinrate: 0.6,
  });
  assert.deepEqual(decision.toUnblock.map((entry) => entry.hour), [12]);
  assert.deepEqual(decision.blockedHours, [9]);
});

test("decideHourBlocks: час исчез из статистики — открываем даже при выросшем винрейте", () => {
  const decision = decide([hour(15, 6, 9)], [9], { atBlock: 0.4, now: 0.9 });
  assert.deepEqual(decision.toUnblock.map((entry) => entry.hour), [9]);
});

test("decideHourBlocks: ручную блокировку гистерезис не снимает", () => {
  // Время второго шанса пришло (эталон 15 ≥ 10 × 1.5) и винрейт не вырос — авто-блокировка
  // тут открылась бы. Ручная остаётся: у неё своя проверка (см. hourBlockReview.ts).
  const hours = [hour(9, 3, 10), hour(15, 10, 15)];
  const manual: BlockedHourState = { hour: 9, overallWinrateAtBlock: 0.5, manual: true };
  const decision = decideHourBlocks({ hours, blocked: [manual], overallWinrate: 0.5 });
  assert.deepEqual(decision.toUnblock, []);
  assert.deepEqual(decision.blockedHours, [9]);
});

test("decideHourBlocks: ручная блокировка держится и на часе без статистики", () => {
  // Час закрыт решением, сделок в нём нет вовсе — ветка «час пропал из статистики»
  // не должна его открыть.
  const hours = [hour(15, 10, 15)];
  const manual: BlockedHourState = { hour: 9, overallWinrateAtBlock: null, manual: true };
  const decision = decideHourBlocks({ hours, blocked: [manual], overallWinrate: 0.6 });
  assert.deepEqual(decision.toUnblock, []);
  assert.deepEqual(decision.blockedHours, [9]);
});

test("decideHourBlocks: ручная блокировка не мешает авто-правилу закрывать другие часы", () => {
  const hours = [hour(9, 0, 2), hour(12, 3, 16), hour(15, 10, 15)];
  const manual: BlockedHourState = { hour: 9, overallWinrateAtBlock: null, manual: true };
  const decision = decideHourBlocks({ hours, blocked: [manual], overallWinrate: 0.6 });
  assert.deepEqual(decision.toBlock.map((entry) => entry.hour), [12]);
  assert.deepEqual(decision.blockedHours, [9, 12]);
});

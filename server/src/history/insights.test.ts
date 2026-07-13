import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTimeOfDayStats } from "./insights.js";

const TZ = 180; // UTC+3

function tradeAt(hourUtc: number, resultR: number | null) {
  return { openedAt: new Date(`2026-07-13T${String(hourUtc).padStart(2, "0")}:00:00Z`), resultR };
}

test("computeTimeOfDayStats: пустой список — все периоды нулевые, bestPeriod null", () => {
  const stats = computeTimeOfDayStats([], TZ);
  assert.equal(stats.bestPeriod, null);
  assert.ok(stats.periods.every((p) => p.totalTrades === 0));
});

test("computeTimeOfDayStats: сдвиг таймзоны переносит сделку в правильный период", () => {
  // 04:00 UTC + 180 мин (UTC+3) = 07:00 локального → период "утро"
  const stats = computeTimeOfDayStats([tradeAt(4, 1)], TZ);
  const morning = stats.periods.find((p) => p.key === "morning");
  assert.equal(morning?.totalTrades, 1);
  assert.equal(morning?.profitableTrades, 1);
  assert.equal(stats.bestPeriod, "morning");
});

test("computeTimeOfDayStats: убыточные сделки не считаются прибыльными, но входят в totalTrades", () => {
  const stats = computeTimeOfDayStats([tradeAt(4, -1)], TZ);
  const morning = stats.periods.find((p) => p.key === "morning");
  assert.equal(morning?.totalTrades, 1);
  assert.equal(morning?.profitableTrades, 0);
  assert.equal(morning?.winRate, 0);
  assert.equal(stats.bestPeriod, null);
});

test("computeTimeOfDayStats: сделки без результата (ещё не закрыты) игнорируются", () => {
  const stats = computeTimeOfDayStats([tradeAt(4, null)], TZ);
  assert.ok(stats.periods.every((p) => p.totalTrades === 0));
});

test("computeTimeOfDayStats: выбирает период с наибольшим числом прибыльных сделок", () => {
  const trades = [
    tradeAt(4, 1), // 07:00 локально → утро
    tradeAt(4, 1), // утро: 2 прибыльных
    tradeAt(10, 1), // 13:00 локально → день: 1 прибыльная
    tradeAt(10, -1), // день: 1 убыточная
  ];
  const stats = computeTimeOfDayStats(trades, TZ);
  assert.equal(stats.bestPeriod, "morning");
  const morning = stats.periods.find((p) => p.key === "morning");
  const day = stats.periods.find((p) => p.key === "day");
  assert.equal(morning?.profitableTrades, 2);
  assert.equal(day?.totalTrades, 2);
  assert.equal(day?.profitableTrades, 1);
  assert.equal(day?.winRate, 0.5);
});

test("computeTimeOfDayStats: нулевой результат (breakeven) не считается прибыльной сделкой", () => {
  const stats = computeTimeOfDayStats([tradeAt(4, 0)], TZ);
  const morning = stats.periods.find((p) => p.key === "morning");
  assert.equal(morning?.totalTrades, 1);
  assert.equal(morning?.profitableTrades, 0);
  assert.equal(stats.bestPeriod, null);
});

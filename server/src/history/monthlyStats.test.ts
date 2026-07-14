import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMonthlyStats, type MonthlyStatTradeInput } from "./monthlyStats.js";

const TZ = 180; // UTC+3

function trade(input: {
  openedAt: string;
  closedAt: string | null;
  resultR: number | null;
  riskUsd?: number | null;
  closeReason?: string | null;
  rrPreset?: string | null;
}): MonthlyStatTradeInput {
  return {
    openedAt: new Date(input.openedAt),
    closedAt: input.closedAt ? new Date(input.closedAt) : null,
    resultR: input.resultR,
    riskUsd: input.riskUsd ?? 10,
    closeReason: input.closeReason ?? null,
    rrPreset: input.rrPreset ?? null,
  };
}

const noBaseline = () => null;

test("computeMonthlyStats: без сделок — пустой список", () => {
  assert.deepEqual(computeMonthlyStats([], TZ, noBaseline), []);
});

test("computeMonthlyStats: сделки без результата или без closedAt игнорируются", () => {
  const trades = [
    trade({ openedAt: "2026-07-01T10:00:00Z", closedAt: null, resultR: null }),
    trade({ openedAt: "2026-07-01T10:00:00Z", closedAt: "2026-07-01T12:00:00Z", resultR: null }),
  ];
  assert.deepEqual(computeMonthlyStats(trades, TZ, noBaseline), []);
});

test("computeMonthlyStats: группирует по месяцу ЗАКРЫТИЯ, считает базовые агрегаты", () => {
  const trades = [
    trade({
      openedAt: "2026-07-01T10:00:00Z",
      closedAt: "2026-07-01T12:00:00Z",
      resultR: 2,
      riskUsd: 10,
      closeReason: "tp",
      rrPreset: "1/2",
    }),
    trade({
      openedAt: "2026-07-05T10:00:00Z",
      closedAt: "2026-07-05T12:00:00Z",
      resultR: -1,
      riskUsd: 10,
      closeReason: "sl",
    }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, noBaseline, new Date("2026-07-20T00:00:00Z"));
  assert.ok(stat);
  assert.equal(stat.year, 2026);
  assert.equal(stat.month, 7);
  assert.equal(stat.totalTrades, 2);
  assert.equal(stat.tpCount, 1);
  assert.equal(stat.slCount, 1);
  assert.equal(stat.beCount, 0);
  assert.equal(stat.sumR, 1);
  assert.equal(stat.winRate, 0.5);
  assert.equal(stat.tradingDays, 2);
  assert.deepEqual(stat.byRRPreset, [{ preset: "1/2", count: 1 }]);
});

test("computeMonthlyStats: сделка около нуля результата — считается 'в безубытке' независимо от closeReason", () => {
  const trades = [
    trade({ openedAt: "2026-07-01T10:00:00Z", closedAt: "2026-07-01T12:00:00Z", resultR: 0.02, closeReason: "manual" }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, noBaseline);
  assert.ok(stat);
  assert.equal(stat.beCount, 1);
  assert.equal(stat.tpCount, 0);
  assert.equal(stat.otherCount, 0);
});

test("computeMonthlyStats: resultPct null без снимка эквити, иначе — % от базы", () => {
  const trades = [
    trade({ openedAt: "2026-07-01T10:00:00Z", closedAt: "2026-07-01T12:00:00Z", resultR: 5, riskUsd: 20 }),
  ];
  const withoutBaseline = computeMonthlyStats(trades, TZ, noBaseline)[0];
  assert.ok(withoutBaseline);
  assert.equal(withoutBaseline.resultPct, null);

  const withBaseline = computeMonthlyStats(trades, TZ, () => 1000)[0];
  assert.ok(withBaseline);
  // 5R * 20$ = 100$ прибыли / 1000$ базы = 10%
  assert.equal(withBaseline.resultPct, 10);
});

test("computeMonthlyStats: дни без торговли считаются относительно дней, прошедших в текущем месяце", () => {
  const trades = [
    trade({ openedAt: "2026-07-01T10:00:00Z", closedAt: "2026-07-01T12:00:00Z", resultR: 1 }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, noBaseline, new Date("2026-07-10T00:00:00Z"));
  assert.ok(stat);
  assert.equal(stat.tradingDays, 1);
  // 10 июля ещё не наступило полностью — locale-day для today в TZ=+3 всё ещё 10-е число
  assert.equal(stat.daysWithoutTrading, 9);
  assert.equal(stat.daysInMonth, 31);
});

test("computeMonthlyStats: для прошедшего месяца используется полное число дней в месяце", () => {
  const trades = [
    trade({ openedAt: "2026-06-01T10:00:00Z", closedAt: "2026-06-01T12:00:00Z", resultR: 1 }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, noBaseline, new Date("2026-07-10T00:00:00Z"));
  assert.ok(stat);
  assert.equal(stat.daysInMonth, 30);
  assert.equal(stat.daysWithoutTrading, 29);
});

test("computeMonthlyStats: сортировка — новые месяцы сначала", () => {
  const trades = [
    trade({ openedAt: "2026-05-01T10:00:00Z", closedAt: "2026-05-01T12:00:00Z", resultR: 1 }),
    trade({ openedAt: "2026-07-01T10:00:00Z", closedAt: "2026-07-01T12:00:00Z", resultR: 1 }),
    trade({ openedAt: "2026-06-01T10:00:00Z", closedAt: "2026-06-01T12:00:00Z", resultR: 1 }),
  ];
  const stats = computeMonthlyStats(trades, TZ, noBaseline, new Date("2026-07-20T00:00:00Z"));
  assert.deepEqual(stats.map((s) => s.month), [7, 6, 5]);
});

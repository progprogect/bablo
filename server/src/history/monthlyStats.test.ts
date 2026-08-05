import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMonthlyStats, type MonthlyStatTradeInput } from "./monthlyStats.js";
import { RR_PRESETS } from "../trades/math.js";

const TZ = 180; // UTC+3

function trade(input: {
  openedAt: string;
  closedAt: string | null;
  resultR: number | null;
  riskUsd?: number | null;
  closeReason?: string | null;
  rrPreset?: string | null;
  entryPrice?: number | null;
  slPrice?: number | null;
  side?: "long" | "short" | null;
  quantity?: number | null;
  partialTpPrice?: number | null;
  partialTpFilledAt?: string | null;
  nightTpAppliedAt?: string | null;
  statsRrPreset?: string | null;
}): MonthlyStatTradeInput {
  return {
    openedAt: new Date(input.openedAt),
    closedAt: input.closedAt ? new Date(input.closedAt) : null,
    resultR: input.resultR,
    riskUsd: input.riskUsd ?? 10,
    closeReason: input.closeReason ?? null,
    rrPreset: input.rrPreset ?? null,
    entryPrice: input.entryPrice ?? null,
    slPrice: input.slPrice ?? null,
    side: input.side ?? null,
    quantity: input.quantity ?? null,
    partialTpPrice: input.partialTpPrice ?? null,
    partialTpFilledAt: input.partialTpFilledAt ? new Date(input.partialTpFilledAt) : null,
    nightTpAppliedAt: input.nightTpAppliedAt ? new Date(input.nightTpAppliedAt) : null,
    statsRrPreset: input.statsRrPreset ?? null,
  };
}

test("computeMonthlyStats: без сделок — пустой список", () => {
  assert.deepEqual(computeMonthlyStats([], TZ, null), []);
});

test("computeMonthlyStats: сделки без результата или без closedAt игнорируются", () => {
  const trades = [
    trade({ openedAt: "2026-07-01T10:00:00Z", closedAt: null, resultR: null }),
    trade({ openedAt: "2026-07-01T10:00:00Z", closedAt: "2026-07-01T12:00:00Z", resultR: null }),
  ];
  assert.deepEqual(computeMonthlyStats(trades, TZ, null), []);
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
  const [stat] = computeMonthlyStats(trades, TZ, null, [], new Date("2026-07-20T00:00:00Z"));
  assert.ok(stat);
  assert.equal(stat.year, 2026);
  assert.equal(stat.month, 7);
  assert.equal(stat.totalTrades, 2);
  assert.equal(stat.tpCount, 1);
  assert.equal(stat.slCount, 1);
  assert.equal(stat.beCount, 0);
  assert.equal(stat.sumR, 1);
  assert.equal(stat.sumPositiveR, 2);
  assert.equal(stat.sumNegativeR, -1);
  assert.equal(stat.winRate, 0.5);
  assert.equal(stat.tradingDays, 2);
  // Все пресеты присутствуют в списке (даже с нулём сделок), чтобы клиент мог показать полную сетку.
  assert.deepEqual(
    stat.byRRPreset,
    RR_PRESETS.map((preset) => ({ preset, count: preset === "1/2" ? 1 : 0 })),
  );
});

test("computeMonthlyStats: сделка около нуля результата — считается 'в безубытке' независимо от closeReason", () => {
  const trades = [
    trade({ openedAt: "2026-07-01T10:00:00Z", closedAt: "2026-07-01T12:00:00Z", resultR: 0.02, closeReason: "manual" }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, null);
  assert.ok(stat);
  assert.equal(stat.beCount, 1);
  assert.equal(stat.tpCount, 0);
  assert.equal(stat.otherCount, 0);
  // resultR > 0, поэтому попадает в sumPositiveR несмотря на то, что засчитана как безубыток.
  assert.equal(stat.sumPositiveR, 0.02);
  assert.equal(stat.sumNegativeR, 0);
});

test("computeMonthlyStats: resultPct null без якоря эквити, иначе — % от базы, восстановленной от якоря", () => {
  const trades = [
    trade({ openedAt: "2026-07-01T10:00:00Z", closedAt: "2026-07-01T12:00:00Z", resultR: 5, riskUsd: 20 }),
  ];
  const withoutAnchor = computeMonthlyStats(trades, TZ, null)[0];
  assert.ok(withoutAnchor);
  assert.equal(withoutAnchor.resultPct, null);

  // Якорь ровно на начало месяца — база берётся как есть, без отката PnL.
  const anchorAtMonthStart = computeMonthlyStats(trades, TZ, { date: "2026-07-01", equity: 1000 })[0];
  assert.ok(anchorAtMonthStart);
  // 5R * 20$ = 100$ прибыли / 1000$ базы = 10%
  assert.equal(anchorAtMonthStart.resultPct, 10);

  // Якорь через месяц вперёд, после сделки — база на начало июля восстанавливается
  // "откручиванием" назад дохода этой сделки: 1100 (текущий баланс) − 100$ прибыли = 1000$.
  const anchorLater = computeMonthlyStats(trades, TZ, { date: "2026-08-01", equity: 1100 })[0];
  assert.ok(anchorLater);
  assert.equal(anchorLater.resultPct, 10);
});

test("computeMonthlyStats: ручное пополнение/вывод учитывается при восстановлении базы от якоря", () => {
  const trades = [
    trade({ openedAt: "2026-07-01T10:00:00Z", closedAt: "2026-07-01T12:00:00Z", resultR: 5, riskUsd: 20 }), // +100$
  ];
  // Текущий баланс 1150$ на 01.08 — это 1000$ база + 100$ прибыли по сделке + 50$ пополнение 05.07.
  const anchor = { date: "2026-08-01", equity: 1150 };
  const adjustments = [{ date: "2026-07-05", amountUsd: 50 }];

  const stat = computeMonthlyStats(trades, TZ, anchor, adjustments)[0];
  assert.ok(stat);
  // 1150 − 100 (PnL) − 50 (пополнение) = 1000 → 100$ / 1000$ = 10%, как и без пополнения.
  assert.equal(stat.resultPct, 10);

  const statIgnoringAdjustment = computeMonthlyStats(trades, TZ, anchor)[0];
  assert.ok(statIgnoringAdjustment);
  // Без учёта пополнения база была бы 1050$, а не 1000$ — процент оказался бы ниже реального.
  assert.ok(Math.abs((statIgnoringAdjustment.resultPct ?? 0) - (100 / 1050) * 100) < 1e-9);
});

test("computeMonthlyStats: дни без торговли считаются относительно дней, прошедших в текущем месяце", () => {
  const trades = [
    trade({ openedAt: "2026-07-01T10:00:00Z", closedAt: "2026-07-01T12:00:00Z", resultR: 1 }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, null, [], new Date("2026-07-10T00:00:00Z"));
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
  const [stat] = computeMonthlyStats(trades, TZ, null, [], new Date("2026-07-10T00:00:00Z"));
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
  const stats = computeMonthlyStats(trades, TZ, null, [], new Date("2026-07-20T00:00:00Z"));
  assert.deepEqual(stats.map((s) => s.month), [7, 6, 5]);
});

test("computeMonthlyStats: исполненная partial 2R → столбец 2R, даже при закрытии по БУ", () => {
  // entry 100, risk 10$/шт × 10 = 100$, partial 120 = 2R; закрытие по БУ после подтяжки SL
  const trades = [
    trade({
      openedAt: "2026-07-01T10:00:00Z",
      closedAt: "2026-07-01T18:00:00Z",
      resultR: 0.02,
      riskUsd: 100,
      closeReason: "sl",
      rrPreset: "1/10",
      entryPrice: 100,
      quantity: 10,
      partialTpPrice: 120,
      partialTpFilledAt: "2026-07-01T14:00:00Z",
    }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, null);
  assert.ok(stat);
  assert.equal(stat.beCount, 1);
  assert.equal(stat.byRRPreset.find((e) => e.preset === "1/2")?.count, 1);
  assert.equal(stat.byRRPreset.find((e) => e.preset === "1/10")?.count, 0);
});

test("computeMonthlyStats: partial 3R не сработала, выбило по стопу — в сетке R нет, это SL", () => {
  const trades = [
    trade({
      openedAt: "2026-07-01T10:00:00Z",
      closedAt: "2026-07-01T12:00:00Z",
      resultR: -1,
      riskUsd: 100,
      closeReason: "sl",
      rrPreset: "1/10",
      entryPrice: 100,
      quantity: 10,
      partialTpPrice: 130,
      partialTpFilledAt: null,
    }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, null);
  assert.ok(stat);
  assert.equal(stat.slCount, 1);
  assert.equal(stat.tpCount, 0);
  assert.ok(stat.byRRPreset.every((e) => e.count === 0));
});

test("computeMonthlyStats: ночной TP 1/1 без partial — стоп, не 1R в сетке", () => {
  const trades = [
    trade({
      openedAt: "2026-07-01T10:00:00Z",
      closedAt: "2026-07-01T22:30:00Z",
      resultR: 1,
      riskUsd: 100,
      closeReason: "tp",
      rrPreset: "1/1", // переписан ночным правилом
      entryPrice: 100,
      quantity: 10,
      partialTpPrice: null, // снят при ночном TP
      partialTpFilledAt: null,
      nightTpAppliedAt: "2026-07-01T22:00:00Z",
    }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, null);
  assert.ok(stat);
  assert.equal(stat.slCount, 1);
  assert.equal(stat.tpCount, 0);
  assert.equal(stat.byRRPreset.find((e) => e.preset === "1/1")?.count, 0);
});

test("computeMonthlyStats: partial 2R исполнена, затем остаток дошёл до основного TP — в сетке 2R", () => {
  const trades = [
    trade({
      openedAt: "2026-07-01T10:00:00Z",
      closedAt: "2026-07-02T10:00:00Z",
      resultR: 4,
      riskUsd: 100,
      closeReason: "tp",
      rrPreset: "1/10",
      entryPrice: 100,
      quantity: 10,
      partialTpPrice: 120,
      partialTpFilledAt: "2026-07-01T14:00:00Z",
    }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, null);
  assert.ok(stat);
  assert.equal(stat.tpCount, 1);
  assert.equal(stat.byRRPreset.find((e) => e.preset === "1/2")?.count, 1);
  assert.equal(stat.byRRPreset.find((e) => e.preset === "1/10")?.count, 0);
});

test("computeMonthlyStats: statsRrPreset оверрайд побеждает авто и ночной стоп", () => {
  const trades = [
    trade({
      openedAt: "2026-07-01T10:00:00Z",
      closedAt: "2026-07-01T22:30:00Z",
      resultR: 1,
      riskUsd: 100,
      closeReason: "tp",
      rrPreset: "1/1",
      entryPrice: 100,
      quantity: 10,
      nightTpAppliedAt: "2026-07-01T22:00:00Z",
      statsRrPreset: "1/3",
    }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, null);
  assert.ok(stat);
  assert.equal(stat.byRRPreset.find((e) => e.preset === "1/3")?.count, 1);
  assert.equal(stat.byRRPreset.find((e) => e.preset === "1/1")?.count, 0);
});

test("computeMonthlyStats: statsRrPreset none — не в сетке даже при тейке", () => {
  const trades = [
    trade({
      openedAt: "2026-07-01T10:00:00Z",
      closedAt: "2026-07-01T12:00:00Z",
      resultR: 2,
      closeReason: "tp",
      rrPreset: "1/2",
      statsRrPreset: "none",
    }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, null);
  assert.ok(stat);
  assert.equal(stat.tpCount, 1);
  assert.ok(stat.byRRPreset.every((e) => e.count === 0));
});

test("computeMonthlyStats: стоп с исходным SL и resultR≈0 — не БУ (баг rp=0)", () => {
  const trades = [
    trade({
      openedAt: "2026-07-01T10:00:00Z",
      closedAt: "2026-07-01T12:00:00Z",
      resultR: 0,
      riskUsd: 20,
      closeReason: "sl",
      entryPrice: 100,
      slPrice: 90,
      side: "long",
      quantity: 2,
    }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, null);
  assert.ok(stat);
  assert.equal(stat.beCount, 0);
  assert.equal(stat.slCount, 1);
});

test("computeMonthlyStats: стоп на входе (БУ после partial) с resultR≈0 — БУ", () => {
  const trades = [
    trade({
      openedAt: "2026-07-01T10:00:00Z",
      closedAt: "2026-07-01T12:00:00Z",
      resultR: 0.02,
      riskUsd: 20,
      closeReason: "sl",
      entryPrice: 100,
      slPrice: 100,
      side: "long",
      quantity: 2,
    }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, null);
  assert.ok(stat);
  assert.equal(stat.beCount, 1);
  assert.equal(stat.slCount, 0);
});

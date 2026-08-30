import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMonthlyStats, STATS_GRID_PRESETS, type MonthlyStatTradeInput } from "./monthlyStats.js";

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
  // Все пресеты сетки присутствуют в списке (даже с нулём сделок), чтобы клиент мог показать полную сетку.
  assert.deepEqual(
    stat.byRRPreset,
    STATS_GRID_PRESETS.map((preset) => ({ preset, count: preset === "1/2" ? 1 : 0 })),
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
  // R учитывается с точностью до десятых (roundStatsR): 0.02R показывается как 0R,
  // поэтому и в суммы даёт 0 — иначе «+R» в карточке не сходился бы с карточками сделок.
  assert.equal(stat.sumPositiveR, 0);
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
  assert.equal(stat.byRRPreset.find((e) => e.preset === "1/4")?.count, 0);
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

test("computeMonthlyStats: ночной TP 1/1 закрыт по тейку — Тейк и 1R в сетке", () => {
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
  assert.equal(stat.tpCount, 1);
  assert.equal(stat.slCount, 0);
  assert.equal(stat.byRRPreset.find((e) => e.preset === "1/1")?.count, 1);
});

test("computeMonthlyStats: ночной TP применён, но закрытие по SL — стоп, не в сетке", () => {
  const trades = [
    trade({
      openedAt: "2026-07-01T10:00:00Z",
      closedAt: "2026-07-01T22:30:00Z",
      resultR: -1,
      riskUsd: 100,
      closeReason: "sl",
      rrPreset: "1/1",
      entryPrice: 100,
      slPrice: 90,
      side: "long",
      quantity: 10,
      nightTpAppliedAt: "2026-07-01T22:00:00Z",
    }),
  ];
  const [stat] = computeMonthlyStats(trades, TZ, null);
  assert.ok(stat);
  assert.equal(stat.slCount, 1);
  assert.equal(stat.tpCount, 0);
  assert.ok(stat.byRRPreset.every((e) => e.count === 0));
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
  assert.equal(stat.byRRPreset.find((e) => e.preset === "1/4")?.count, 0);
});

test("computeMonthlyStats: statsRrPreset оверрайд побеждает авто и ночной тейк", () => {
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

test("computeMonthlyStats: стоп, уведённый в прибыль — тейк и столбец по уровню стопа", () => {
  // План 1/3, ночью цена ушла за 1/1 → SL подтянут на 110 (+1R), там и закрылось.
  // Ожидаем: в разбивке это тейк, в сетке R — столбец 1/1, а не плановый 1/3.
  const stats = computeMonthlyStats(
    [
      {
        openedAt: new Date("2026-08-10T10:00:00Z"),
        closedAt: new Date("2026-08-10T23:30:00Z"),
        closeReason: "sl",
        resultR: 1,
        riskUsd: 100,
        rrPreset: "1/3",
        entryPrice: 100,
        slPrice: 110,
        side: "long",
        quantity: 10,
        partialTpPrice: null,
        partialTpFilledAt: null,
        statsRrPreset: null,
      },
    ],
    180,
    null,
    [],
  );

  const month = stats[0]!;
  assert.equal(month.tpCount, 1);
  assert.equal(month.slCount, 0);
  assert.equal(month.beCount, 0);
  assert.deepEqual(
    month.byRRPreset.filter((entry) => entry.count > 0),
    [{ preset: "1/1", count: 1 }],
  );
});

test("computeMonthlyStats: обычный стоп остаётся стопом и вне сетки R", () => {
  const stats = computeMonthlyStats(
    [
      {
        openedAt: new Date("2026-08-10T10:00:00Z"),
        closedAt: new Date("2026-08-10T12:00:00Z"),
        closeReason: "sl",
        resultR: -1,
        riskUsd: 100,
        rrPreset: "1/3",
        entryPrice: 100,
        slPrice: 90,
        side: "long",
        quantity: 10,
        partialTpPrice: null,
        partialTpFilledAt: null,
        statsRrPreset: null,
      },
    ],
    180,
    null,
    [],
  );

  const month = stats[0]!;
  assert.equal(month.slCount, 1);
  assert.equal(month.tpCount, 0);
  assert.deepEqual(month.byRRPreset.filter((entry) => entry.count > 0), []);
});

test("computeMonthlyStats: ручной оверрайд исхода переносит сделку из стопов в тейки", () => {
  const base = {
    openedAt: new Date("2026-08-10T10:00:00Z"),
    closedAt: new Date("2026-08-10T12:00:00Z"),
    closeReason: "sl",
    resultR: -1,
    riskUsd: 100,
    rrPreset: "1/2",
    entryPrice: 100,
    slPrice: 90,
    side: "long",
    quantity: 10,
    partialTpPrice: null,
    partialTpFilledAt: null,
    statsRrPreset: null,
  };

  const auto = computeMonthlyStats([base], 180, null, [])[0]!;
  assert.equal(auto.slCount, 1);
  assert.equal(auto.tpCount, 0);
  assert.deepEqual(auto.byRRPreset.filter((entry) => entry.count > 0), []);

  const overridden = computeMonthlyStats([{ ...base, statsOutcome: "tp" }], 180, null, [])[0]!;
  assert.equal(overridden.tpCount, 1);
  assert.equal(overridden.slCount, 0);
  // Помечена тейком → в сетке появляется её плановый пресет
  assert.deepEqual(
    overridden.byRRPreset.filter((entry) => entry.count > 0),
    [{ preset: "1/2", count: 1 }],
  );
});

test("computeMonthlyStats: тейк, помеченный стопом вручную, уходит из сетки R", () => {
  const stats = computeMonthlyStats(
    [
      {
        openedAt: new Date("2026-08-10T10:00:00Z"),
        closedAt: new Date("2026-08-10T12:00:00Z"),
        closeReason: "tp",
        resultR: 2,
        riskUsd: 100,
        rrPreset: "1/2",
        entryPrice: 100,
        slPrice: 90,
        side: "long",
        quantity: 10,
        partialTpPrice: null,
        partialTpFilledAt: null,
        statsRrPreset: null,
        statsOutcome: "sl",
      },
    ],
    180,
    null,
    [],
  )[0]!;
  assert.equal(stats.slCount, 1);
  assert.equal(stats.tpCount, 0);
  assert.deepEqual(stats.byRRPreset.filter((entry) => entry.count > 0), []);
});

test("computeMonthlyStats: столбец R из админки задаёт и сумму R, деньги остаются фактическими", () => {
  // Записан resultR = 20 при риске 5 USDT (реальный PnL 100 USDT верный, врёт только R).
  // В админке выбран столбец 2R → в статистике сумма R = +2, но % к депозиту по 100 USDT.
  const base = {
    openedAt: new Date("2026-08-10T10:00:00Z"),
    closedAt: new Date("2026-08-10T12:00:00Z"),
    closeReason: "tp",
    resultR: 20,
    riskUsd: 5,
    rrPreset: "1/2",
    entryPrice: 100,
    slPrice: 90,
    side: "long",
    quantity: 10,
    partialTpPrice: null,
    partialTpFilledAt: null,
    statsRrPreset: null,
  };
  const anchor = { date: "2026-08-31", equity: 1000 };

  const auto = computeMonthlyStats([base], 180, anchor, [])[0]!;
  assert.equal(auto.sumR, 20);
  assert.equal(auto.sumPositiveR, 20);

  const fixed = computeMonthlyStats([{ ...base, statsRrPreset: "1/2" }], 180, anchor, [])[0]!;
  assert.equal(fixed.sumR, 2);
  assert.equal(fixed.sumPositiveR, 2);
  assert.equal(fixed.tpCount, 1);
  // % к депозиту не изменился — считается по реальным деньгам (20R × 5 USDT = 100 USDT)
  assert.equal(fixed.resultPct, auto.resultPct);
  assert.deepEqual(
    fixed.byRRPreset.filter((entry) => entry.count > 0),
    [{ preset: "1/2", count: 1 }],
  );
});

test("computeMonthlyStats: столбец R у стопа даёт отрицательный R в сумме", () => {
  const stats = computeMonthlyStats(
    [
      {
        openedAt: new Date("2026-08-10T10:00:00Z"),
        closedAt: new Date("2026-08-10T12:00:00Z"),
        closeReason: "sl",
        resultR: -5,
        riskUsd: 10,
        rrPreset: "1/2",
        entryPrice: 100,
        slPrice: 90,
        side: "long",
        quantity: 10,
        partialTpPrice: null,
        partialTpFilledAt: null,
        statsRrPreset: "1/2",
      },
    ],
    180,
    null,
    [],
  )[0]!;
  assert.equal(stats.sumR, -2);
  assert.equal(stats.sumNegativeR, -2);
  assert.equal(stats.slCount, 1);
});

test("computeMonthlyStats: столбец сетки — по фактически достигнутому R, а не по плану", () => {
  const base = {
    openedAt: new Date("2026-08-10T10:00:00Z"),
    closedAt: new Date("2026-08-10T12:00:00Z"),
    closeReason: "tp",
    riskUsd: 20,
    rrPreset: "1/3", // план 1/3
    entryPrice: 100,
    slPrice: 90,
    side: "long",
    quantity: 10,
    partialTpPrice: null,
    partialTpFilledAt: null,
    statsRrPreset: null,
  };

  // Фактически дала 2.09R → столбец 2R, а не плановый 3R
  const byFact = computeMonthlyStats([{ ...base, resultR: 2.09 }], 180, null, [])[0]!;
  assert.deepEqual(
    byFact.byRRPreset.filter((entry) => entry.count > 0),
    [{ preset: "1/2", count: 1 }],
  );

  // Тейк 1/3 с обычными комиссиями (2.95R) остаётся в 3R
  const nearPlan = computeMonthlyStats([{ ...base, resultR: 2.95 }], 180, null, [])[0]!;
  assert.deepEqual(
    nearPlan.byRRPreset.filter((entry) => entry.count > 0),
    [{ preset: "1/3", count: 1 }],
  );

  // Достигнутый R далеко от всех уровней сетки — откат на план, чтобы не выпасть из сетки
  const fallback = computeMonthlyStats([{ ...base, resultR: 25 }], 180, null, [])[0]!;
  assert.deepEqual(
    fallback.byRRPreset.filter((entry) => entry.count > 0),
    [{ preset: "1/3", count: 1 }],
  );
});

test("computeMonthlyStats: сумма R = сумма округлённых R по сделкам, а не округление суммы", () => {
  // Три тейка по 1.04R: в карточках каждая показывается как 1R.
  // Сумма округлений = 3R; округление суммы (3.12) дало бы 3.1R — и цифры не сходились бы.
  const base = {
    closedAt: new Date("2026-08-10T12:00:00Z"),
    closeReason: "tp",
    riskUsd: 20,
    rrPreset: "1/1",
    entryPrice: 100,
    slPrice: 90,
    side: "long",
    quantity: 10,
    partialTpPrice: null,
    partialTpFilledAt: null,
    statsRrPreset: null,
    resultR: 1.04,
  };
  const stats = computeMonthlyStats(
    [
      { ...base, openedAt: new Date("2026-08-10T10:00:00Z") },
      { ...base, openedAt: new Date("2026-08-11T10:00:00Z") },
      { ...base, openedAt: new Date("2026-08-12T10:00:00Z") },
    ],
    180,
    null,
    [],
  )[0]!;

  assert.equal(stats.sumR, 3);
  assert.equal(stats.sumPositiveR, 3);
});

test("computeMonthlyStats: убытки тоже суммируются из округлённых значений", () => {
  const base = {
    closedAt: new Date("2026-08-10T12:00:00Z"),
    closeReason: "sl",
    riskUsd: 20,
    rrPreset: "1/2",
    entryPrice: 100,
    slPrice: 90,
    side: "long",
    quantity: 10,
    partialTpPrice: null,
    partialTpFilledAt: null,
    statsRrPreset: null,
    resultR: -1.1185, // шаг 0.5 → в карточке −1R
  };
  const stats = computeMonthlyStats(
    [
      { ...base, openedAt: new Date("2026-08-10T10:00:00Z") },
      { ...base, openedAt: new Date("2026-08-11T10:00:00Z") },
    ],
    180,
    null,
    [],
  )[0]!;

  assert.equal(stats.sumR, -2);
  assert.equal(stats.sumNegativeR, -2);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTradeInsights, type InsightTradeInput } from "./insights.js";

const TZ = 180; // UTC+3

function trade(input: {
  symbol?: string;
  openedHourUtc: number;
  closedHourUtc?: number;
  closedMinuteUtc?: number;
  closeReason?: string | null;
  resultR: number | null;
  riskUsd?: number | null;
  rrPreset?: string | null;
  day?: string;
}): InsightTradeInput {
  const day = input.day ?? "2026-07-13";
  const openedAt = new Date(`${day}T${String(input.openedHourUtc).padStart(2, "0")}:00:00Z`);
  const closedAt =
    input.closedHourUtc !== undefined
      ? new Date(
          `${day}T${String(input.closedHourUtc).padStart(2, "0")}:${String(input.closedMinuteUtc ?? 0).padStart(2, "0")}:00Z`,
        )
      : null;
  return {
    symbol: input.symbol ?? "TIA-USDT",
    openedAt,
    closedAt,
    closeReason: input.closeReason ?? null,
    resultR: input.resultR,
    riskUsd: input.riskUsd ?? 10,
    rrPreset: input.rrPreset ?? null,
  };
}

test("computeTradeInsights: пустой список — всё пустое/null", () => {
  const insights = computeTradeInsights([], TZ, 3);
  assert.deepEqual(insights.topProfitableHours, []);
  assert.deepEqual(insights.topStopHours, []);
  assert.deepEqual(insights.assetOutcomes, []);
  assert.deepEqual(insights.topStopAssets, []);
  assert.equal(insights.dailyTargetHour, null);
  assert.equal(insights.rrHoldDuration, null);
  assert.deepEqual(insights.presetOutcomes, []);
});

test("computeTradeInsights: топ часов открытия — доля тейков ≥ 50%", () => {
  const trades = [
    trade({ openedHourUtc: 4, resultR: 1, closeReason: "tp" }), // 07:00 локально
    trade({ openedHourUtc: 4, resultR: 1, closeReason: "tp" }),
    trade({ openedHourUtc: 4, resultR: 1, closeReason: "tp" }),
    trade({ openedHourUtc: 10, resultR: 1, closeReason: "tp" }), // 13:00 локально
    trade({ openedHourUtc: 10, resultR: -1, closeReason: "sl" }),
  ];
  const insights = computeTradeInsights(trades, TZ, 3);
  assert.equal(insights.topProfitableHours[0]?.hour, 7);
  assert.equal(insights.topProfitableHours[0]?.tpCount, 3);
  assert.equal(insights.topProfitableHours[0]?.total, 3);
  // 13:00 — 1/2 (ровно 50%) — входит; ниже по tpCount, поэтому вторым.
  assert.equal(insights.topProfitableHours[1]?.hour, 13);
  assert.equal(insights.topProfitableHours[1]?.tpCount, 1);
  assert.equal(insights.topProfitableHours[1]?.total, 2);
  assert.equal(insights.topProfitableHours.length, 2);
});

test("computeTradeInsights: ровно половина сделок по тейку — час считается прибыльным", () => {
  const trades = [
    trade({ openedHourUtc: 4, resultR: 1, closeReason: "tp" }),
    trade({ openedHourUtc: 4, resultR: -1, closeReason: "sl" }),
  ];
  const insights = computeTradeInsights(trades, TZ, 3);
  assert.equal(insights.topProfitableHours.length, 1);
  assert.equal(insights.topProfitableHours[0]?.hour, 7);
  assert.equal(insights.topProfitableHours[0]?.tpCount, 1);
  assert.equal(insights.topProfitableHours[0]?.total, 2);
});

test("computeTradeInsights: сделки без тейка (даже прибыльные external) не делают час прибыльным", () => {
  const insights = computeTradeInsights([trade({ openedHourUtc: 4, resultR: 1, closeReason: "external" })], TZ, 3);
  assert.deepEqual(insights.topProfitableHours, []);
});

test("computeTradeInsights: топ часов открытия сделок, закрытых по стопу", () => {
  const trades = [
    trade({ openedHourUtc: 5, resultR: -1, closeReason: "sl" }), // 08:00 локально
    trade({ openedHourUtc: 5, resultR: -1, closeReason: "sl" }),
    trade({ openedHourUtc: 5, resultR: 1, closeReason: "tp" }),
    trade({ openedHourUtc: 9, resultR: -1, closeReason: "sl" }), // 12:00 локально
  ];
  const insights = computeTradeInsights(trades, TZ, 3);
  assert.equal(insights.topStopHours[0]?.hour, 8);
  assert.equal(insights.topStopHours[0]?.count, 2);
  assert.equal(insights.topStopHours[1]?.hour, 12);
  assert.equal(insights.topStopHours[1]?.count, 1);
});

test("computeTradeInsights: assetOutcomes — все активы с долей TP, сортировка по hitRate", () => {
  const trades = [
    trade({ symbol: "VIRTUAL-USDT", openedHourUtc: 4, resultR: 1, closeReason: "tp" }),
    trade({ symbol: "VIRTUAL-USDT", openedHourUtc: 4, resultR: -1, closeReason: "sl" }),
    trade({ symbol: "VIRTUAL-USDT", openedHourUtc: 4, resultR: -1, closeReason: "sl" }),
    trade({ symbol: "VIRTUAL-USDT", openedHourUtc: 4, resultR: -1, closeReason: "sl" }),
    trade({ symbol: "VIRTUAL-USDT", openedHourUtc: 4, resultR: -1, closeReason: "sl" }), // 1/5 = 20%
    trade({ symbol: "TIA-USDT", openedHourUtc: 4, resultR: 1, closeReason: "tp" }),
    trade({ symbol: "TIA-USDT", openedHourUtc: 4, resultR: -1, closeReason: "sl" }), // 1/2 = 50%
    trade({ symbol: "TAO-USDT", openedHourUtc: 4, resultR: 1, closeReason: "tp" }), // 1/1 = 100%
  ];
  const insights = computeTradeInsights(trades, TZ, 3);
  assert.deepEqual(
    insights.assetOutcomes.map((entry) => ({
      symbol: entry.symbol,
      tpCount: entry.tpCount,
      totalTrades: entry.totalTrades,
    })),
    [
      { symbol: "TAO-USDT", tpCount: 1, totalTrades: 1 },
      { symbol: "TIA-USDT", tpCount: 1, totalTrades: 2 },
      { symbol: "VIRTUAL-USDT", tpCount: 1, totalTrades: 5 },
    ],
  );
});

test("computeTradeInsights: topStopAssets — топ активов по числу стопов", () => {
  const trades = [
    trade({ symbol: "TIA-USDT", openedHourUtc: 5, resultR: -1, closeReason: "sl" }),
    trade({ symbol: "TIA-USDT", openedHourUtc: 5, resultR: -1, closeReason: "sl" }),
    trade({ symbol: "VIRTUAL-USDT", openedHourUtc: 9, resultR: -1, closeReason: "sl" }),
    trade({ symbol: "TAO-USDT", openedHourUtc: 4, resultR: 1, closeReason: "tp" }),
  ];
  const insights = computeTradeInsights(trades, TZ, 3);
  assert.equal(insights.topStopAssets[0]?.symbol, "TIA-USDT");
  assert.equal(insights.topStopAssets[0]?.count, 2);
  assert.equal(insights.topStopAssets[1]?.symbol, "VIRTUAL-USDT");
  assert.equal(insights.topStopAssets[1]?.count, 1);
  assert.equal(insights.topStopAssets.length, 2);
});

test("computeTradeInsights: dailyTargetHour null, если цель не задана или не достигнута", () => {
  const trades = [trade({ openedHourUtc: 4, closedHourUtc: 4, resultR: 1 })];
  assert.equal(computeTradeInsights(trades, TZ, 0).dailyTargetHour, null);
  assert.equal(computeTradeInsights(trades, TZ, 5).dailyTargetHour, null);
});

test("computeTradeInsights: dailyTargetHour — момент, когда накопленный R за день достиг цели", () => {
  const trades = [
    trade({ day: "2026-07-13", openedHourUtc: 6, closedHourUtc: 8, resultR: 2 }), // 11:00 локально
    trade({ day: "2026-07-13", openedHourUtc: 6, closedHourUtc: 9, closedMinuteUtc: 40, resultR: 1 }), // 12:40 → суммарно 3R, цель достигнута
    trade({ day: "2026-07-13", openedHourUtc: 6, closedHourUtc: 11, resultR: 1 }), // после цели — не влияет
  ];
  const insights = computeTradeInsights(trades, TZ, 3);
  // 12:40 локально → округление вверх до полного часа → 13:00
  assert.equal(insights.dailyTargetHour?.hour, 13);
  assert.equal(insights.dailyTargetHour?.targetR, 3);
});

test("computeTradeInsights: dailyTargetHour берёт медиану по нескольким дням", () => {
  const trades = [
    trade({ day: "2026-07-10", openedHourUtc: 6, closedHourUtc: 7, resultR: 3 }), // 10:00 локально
    trade({ day: "2026-07-11", openedHourUtc: 6, closedHourUtc: 9, resultR: 3 }), // 12:00 локально
  ];
  const insights = computeTradeInsights(trades, TZ, 3);
  // медиана 10:00 и 12:00 → 11:00, минут не было — без округления
  assert.equal(insights.dailyTargetHour?.hour, 11);
});

test("computeTradeInsights: presetOutcomes — сделки без пресета или без результата игнорируются", () => {
  const trades = [
    trade({ openedHourUtc: 4, resultR: 1, rrPreset: null }),
    trade({ openedHourUtc: 4, resultR: null, rrPreset: "1/2" }),
  ];
  const insights = computeTradeInsights(trades, TZ, 3);
  assert.deepEqual(insights.presetOutcomes, []);
});

test("computeTradeInsights: presetOutcomes считает hitRate и средний R закрытых по стопу", () => {
  const trades = [
    // 1/1: 2 из 3 дошли до тейка (hitRate ≈ 0.67), 1 закрылась по стопу с -1R
    trade({ openedHourUtc: 4, resultR: 1, rrPreset: "1/1", closeReason: "tp" }),
    trade({ openedHourUtc: 4, resultR: 1, rrPreset: "1/1", closeReason: "tp" }),
    trade({ openedHourUtc: 4, resultR: -1, rrPreset: "1/1", closeReason: "sl" }),
    // 1/2: 1 из 4 дошла до тейка (hitRate = 0.25), 3 закрылись по стопу со средним -1.5R
    trade({ openedHourUtc: 4, resultR: 2, rrPreset: "1/2", closeReason: "tp" }),
    trade({ openedHourUtc: 4, resultR: -1, rrPreset: "1/2", closeReason: "sl" }),
    trade({ openedHourUtc: 4, resultR: -1.5, rrPreset: "1/2", closeReason: "sl" }),
    trade({ openedHourUtc: 4, resultR: -2, rrPreset: "1/2", closeReason: "sl" }),
  ];
  const insights = computeTradeInsights(trades, TZ, 3);

  const oneToOne = insights.presetOutcomes.find((entry) => entry.preset === "1/1");
  assert.equal(oneToOne?.totalTrades, 3);
  assert.equal(oneToOne?.tpCount, 2);
  assert.ok(Math.abs((oneToOne?.hitRate ?? 0) - 2 / 3) < 1e-9);
  assert.equal(oneToOne?.slCount, 1);
  assert.equal(oneToOne?.avgSlResultR, -1);

  const oneToTwo = insights.presetOutcomes.find((entry) => entry.preset === "1/2");
  assert.equal(oneToTwo?.totalTrades, 4);
  assert.equal(oneToTwo?.tpCount, 1);
  assert.equal(oneToTwo?.hitRate, 0.25);
  assert.equal(oneToTwo?.slCount, 3);
  assert.ok(Math.abs((oneToTwo?.avgSlResultR ?? 0) - -1.5) < 1e-9);

  // Порядок — по канонической последовательности RR_PRESETS, а не по числу сделок.
  assert.deepEqual(insights.presetOutcomes.map((entry) => entry.preset), ["1/1", "1/2"]);
});

test("computeTradeInsights: presetOutcomes — slCount = 0, если все промахи закрылись не по стопу", () => {
  const trades = [
    trade({ openedHourUtc: 4, resultR: 1, rrPreset: "1/3", closeReason: "tp" }),
    trade({ openedHourUtc: 4, resultR: 0, rrPreset: "1/3", closeReason: "external" }),
  ];
  const insights = computeTradeInsights(trades, TZ, 3);
  const oneToThree = insights.presetOutcomes.find((entry) => entry.preset === "1/3");
  assert.equal(oneToThree?.totalTrades, 2);
  assert.equal(oneToThree?.tpCount, 1);
  assert.equal(oneToThree?.slCount, 0);
  assert.equal(oneToThree?.avgSlResultR, 0);
});

test("computeTradeInsights: rrHoldDuration — диапазон часов до тейка по пресету 1/3", () => {
  const trades = [
    // 2 часа до TP
    trade({
      openedHourUtc: 4,
      closedHourUtc: 6,
      resultR: 3,
      rrPreset: "1/3",
      closeReason: "tp",
    }),
    // 7 часов до TP
    trade({
      openedHourUtc: 4,
      closedHourUtc: 11,
      resultR: 3,
      rrPreset: "1/3",
      closeReason: "tp",
    }),
    // SL с 1/3 — не входит в «отработку»
    trade({
      openedHourUtc: 4,
      closedHourUtc: 20,
      resultR: -1,
      rrPreset: "1/3",
      closeReason: "sl",
    }),
    // другой пресет — не входит
    trade({
      openedHourUtc: 4,
      closedHourUtc: 10,
      resultR: 2,
      rrPreset: "1/2",
      closeReason: "tp",
    }),
  ];
  const insights = computeTradeInsights(trades, TZ, 3);
  assert.deepEqual(insights.rrHoldDuration, {
    preset: "1/3",
    minHours: 2,
    maxHours: 7,
    sampleCount: 2,
  });
});

test("computeTradeInsights: rrHoldDuration null, если нет тейков 1/3", () => {
  const trades = [
    trade({
      openedHourUtc: 4,
      closedHourUtc: 6,
      resultR: -1,
      rrPreset: "1/3",
      closeReason: "sl",
    }),
  ];
  assert.equal(computeTradeInsights(trades, TZ, 3).rrHoldDuration, null);
});

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
  };
}

test("computeTradeInsights: пустой список — всё пустое/null", () => {
  const insights = computeTradeInsights([], TZ, 3);
  assert.deepEqual(insights.topProfitableHours, []);
  assert.equal(insights.emptyHours.length, 24);
  assert.deepEqual(insights.topStopHours, []);
  assert.equal(insights.bestAsset, null);
  assert.equal(insights.dailyTargetHour, null);
});

test("computeTradeInsights: сделки без результата (не закрыты) игнорируются в почасовых бакетах", () => {
  const insights = computeTradeInsights([trade({ openedHourUtc: 4, resultR: null })], TZ, 3);
  assert.equal(insights.emptyHours.length, 24);
});

test("computeTradeInsights: топ часов открытия по числу прибыльных сделок", () => {
  const trades = [
    trade({ openedHourUtc: 4, resultR: 1 }), // 07:00 локально
    trade({ openedHourUtc: 4, resultR: 1 }),
    trade({ openedHourUtc: 10, resultR: 1 }), // 13:00 локально
    trade({ openedHourUtc: 10, resultR: -1 }),
  ];
  const insights = computeTradeInsights(trades, TZ, 3);
  assert.equal(insights.topProfitableHours[0]?.hour, 7);
  assert.equal(insights.topProfitableHours[0]?.profitable, 2);
  assert.equal(insights.topProfitableHours[0]?.total, 2);
  assert.equal(insights.topProfitableHours[1]?.hour, 13);
  assert.equal(insights.topProfitableHours[1]?.profitable, 1);
  assert.equal(insights.topProfitableHours[1]?.total, 2);
});

test("computeTradeInsights: безубыточная сделка (resultR = 0) не считается прибыльной", () => {
  const insights = computeTradeInsights([trade({ openedHourUtc: 4, resultR: 0 })], TZ, 3);
  assert.deepEqual(insights.topProfitableHours, []);
});

test("computeTradeInsights: часы без единой сделки попадают в emptyHours", () => {
  const insights = computeTradeInsights([trade({ openedHourUtc: 4, resultR: 1 })], TZ, 3);
  assert.equal(insights.emptyHours.includes(7), false);
  assert.equal(insights.emptyHours.length, 23);
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

test("computeTradeInsights: самый прибыльный актив выбирается по сумме $, а не по числу сделок", () => {
  const trades = [
    trade({ symbol: "TIA-USDT", openedHourUtc: 4, resultR: 5, riskUsd: 10, closeReason: "tp" }), // +50$
    trade({ symbol: "TAO-USDT", openedHourUtc: 4, resultR: 1, riskUsd: 5, closeReason: "tp" }), // +5$
    trade({ symbol: "TAO-USDT", openedHourUtc: 4, resultR: 1, riskUsd: 5, closeReason: "tp" }), // +5$ (больше сделок, меньше $)
  ];
  const insights = computeTradeInsights(trades, TZ, 3);
  assert.equal(insights.bestAsset?.symbol, "TIA-USDT");
  assert.equal(insights.bestAsset?.tpCount, 1);
});

test("computeTradeInsights: актив без прибыли (сумма ≤ 0) не считается лучшим", () => {
  const trades = [trade({ symbol: "TIA-USDT", openedHourUtc: 4, resultR: -1, riskUsd: 10 })];
  const insights = computeTradeInsights(trades, TZ, 3);
  assert.equal(insights.bestAsset, null);
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

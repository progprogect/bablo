import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTradeInsights, type InsightTradeInput } from "./insights.js";

const TZ = 180; // UTC+3

function trade(input: {
  openedHourUtc: number;
  closeReason?: string | null;
  resultR: number | null;
  day?: string;
  /** Цена входа/стопа — для сделок, где стоп уведён в прибыль (см. history/outcome.ts). */
  entryPrice?: number | null;
  slPrice?: number | null;
  side?: string;
  statsOutcome?: string | null;
}): InsightTradeInput {
  const day = input.day ?? "2026-07-13";
  return {
    openedAt: new Date(`${day}T${String(input.openedHourUtc).padStart(2, "0")}:00:00Z`),
    closeReason: input.closeReason ?? null,
    resultR: input.resultR,
    // По умолчанию стоп ниже входа — обычный защитный SL лонга.
    entryPrice: input.entryPrice ?? 100,
    slPrice: input.slPrice ?? 90,
    side: input.side ?? "long",
    statsOutcome: input.statsOutcome ?? null,
  };
}

test("computeTradeInsights: пустой список — пустые часы", () => {
  assert.deepEqual(computeTradeInsights([], TZ).hourlyOutcomes, []);
});

// Сервер отдаёт ВСЕ часы с хотя бы одной сделкой (без фильтра ≥50% тейков и без
// сортировки по силе) — полный список по порядку часа, раскладку дня делает UI.
test("computeTradeInsights: hourlyOutcomes — все часы со сделками, по номеру часа", () => {
  const trades = [
    trade({ openedHourUtc: 4, resultR: 1, closeReason: "tp" }), // 07:00 локально — 3/3
    trade({ openedHourUtc: 4, resultR: 1, closeReason: "tp" }),
    trade({ openedHourUtc: 4, resultR: 1, closeReason: "tp" }),
    trade({ openedHourUtc: 10, resultR: 1, closeReason: "tp" }), // 13:00 локально — 1/2
    trade({ openedHourUtc: 10, resultR: -1, closeReason: "sl" }),
    // 12:00 локально — 1/3 тейков (час с долей < 50% тоже попадает в ответ)
    trade({ openedHourUtc: 9, resultR: -1, closeReason: "sl" }),
    trade({ openedHourUtc: 9, resultR: -1, closeReason: "sl" }),
    trade({ openedHourUtc: 9, resultR: 1, closeReason: "tp" }),
  ];
  assert.deepEqual(computeTradeInsights(trades, TZ).hourlyOutcomes, [
    { hour: 7, tpCount: 3, total: 3 },
    { hour: 12, tpCount: 1, total: 3 },
    { hour: 13, tpCount: 1, total: 2 },
  ]);
});

test("computeTradeInsights: прибыльный external — в total часа, но не в tpCount", () => {
  const insights = computeTradeInsights(
    [trade({ openedHourUtc: 4, resultR: 1, closeReason: "external" })],
    TZ,
  );
  assert.deepEqual(insights.hourlyOutcomes, [{ hour: 7, tpCount: 0, total: 1 }]);
});

test("computeTradeInsights: сделка без результата не попадает в часы", () => {
  assert.deepEqual(computeTradeInsights([trade({ openedHourUtc: 4, resultR: null })], TZ).hourlyOutcomes, []);
});

test("computeTradeInsights: стоп, уведённый в прибыль — тейк в часах, не стоп", () => {
  const trades = [
    // SL подтянут на 110 (выше входа), закрылось в +1R — по логике это тейк
    trade({ openedHourUtc: 4, resultR: 1, closeReason: "sl", entryPrice: 100, slPrice: 110 }),
    // обычный стоп в минус
    trade({ openedHourUtc: 9, resultR: -1, closeReason: "sl", entryPrice: 100, slPrice: 90 }),
  ];
  assert.deepEqual(computeTradeInsights(trades, TZ).hourlyOutcomes, [
    { hour: 7, tpCount: 1, total: 1 },
    { hour: 12, tpCount: 0, total: 1 },
  ]);
});

test("computeTradeInsights: ручной оверрайд исхода меняет тейки часа", () => {
  const trades = [
    // Реальный стоп, но помечен тейком вручную → в часе считается тейком
    trade({
      openedHourUtc: 4,
      resultR: -1,
      closeReason: "sl",
      entryPrice: 100,
      slPrice: 90,
      statsOutcome: "tp",
    }),
  ];
  assert.deepEqual(computeTradeInsights(trades, TZ).hourlyOutcomes, [{ hour: 7, tpCount: 1, total: 1 }]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  atrSeries,
  computeExcursions,
  emaSeries,
  lastClosedIndex,
  rsiSeries,
  smaAt,
  snapshotAt,
  type Candle,
} from "./indicators.js";

const STEP = 60_000;

function candle(i: number, close: number, high = close + 1, low = close - 1, volume = 100): Candle {
  return { time: i * STEP, open: close, high, low, close, volume };
}

test("smaAt: среднее последних period, null при нехватке", () => {
  const values = [1, 2, 3, 4, 5];
  assert.equal(smaAt(values, 3, 1), null);
  assert.equal(smaAt(values, 3, 2), 2);
  assert.equal(smaAt(values, 3, 4), 4);
});

test("emaSeries: seed — SMA первых period, дальше классическое сглаживание", () => {
  const values = [1, 2, 3, 4, 5];
  const ema = emaSeries(values, 3);
  assert.equal(ema[0], null);
  assert.equal(ema[1], null);
  assert.equal(ema[2], 2); // SMA(1,2,3)
  // k = 0.5: 4*0.5 + 2*0.5 = 3; 5*0.5 + 3*0.5 = 4
  assert.equal(ema[3], 3);
  assert.equal(ema[4], 4);
});

test("rsiSeries: рост без откатов → 100, симметрия у боковика ≈ 50", () => {
  const up = Array.from({ length: 20 }, (_, i) => 100 + i);
  const rsiUp = rsiSeries(up, 14);
  assert.equal(rsiUp[19], 100);

  const flatZigzag = Array.from({ length: 40 }, (_, i) => 100 + (i % 2)); // +1/−1 поровну
  const rsi = rsiSeries(flatZigzag, 14)[39]!;
  assert.ok(rsi > 40 && rsi < 60, `rsi=${rsi}`);
});

test("atrSeries: у свечей с постоянным TR равен этому TR", () => {
  // Свечи: high-low = 2, без гэпов между close.
  const candles = Array.from({ length: 20 }, (_, i) => candle(i, 100));
  const atr = atrSeries(candles, 14);
  assert.equal(atr[13], null);
  assert.ok(Math.abs(atr[14]! - 2) < 1e-9);
  assert.ok(Math.abs(atr[19]! - 2) < 1e-9);
});

test("lastClosedIndex: свеча, в которой момент, ещё не закрыта", () => {
  const candles = Array.from({ length: 5 }, (_, i) => candle(i, 100));
  // Момент внутри свечи 2 → последняя закрытая — 1.
  assert.equal(lastClosedIndex(candles, 2 * STEP + 1, STEP), 1);
  // Ровно на границе открытия свечи 2 → закрыты 0 и 1.
  assert.equal(lastClosedIndex(candles, 2 * STEP, STEP), 1);
  // Раньше первой закрытой — null.
  assert.equal(lastClosedIndex(candles, STEP - 1, STEP), null);
});

test("snapshotAt: на стабильном ряду EMA/BB сходятся к цене, дистанции нулевые", () => {
  const candles = Array.from({ length: 250 }, (_, i) => candle(i, 100, 100.5, 99.5, 100));
  const snap = snapshotAt(candles, 249);
  assert.ok(Math.abs(snap.ema21! - 100) < 1e-6);
  assert.ok(Math.abs(snap.ema200! - 100) < 1e-6);
  assert.ok(Math.abs(snap.priceToEma50Pct!) < 1e-6);
  assert.ok(Math.abs(snap.bollinger!.middle - 100) < 1e-9);
  assert.ok(Math.abs(snap.bollinger!.percentB - 0.5) < 1e-9);
  assert.ok(Math.abs(snap.macd!.line) < 1e-6);
  assert.equal(snap.volumeRatio20, 1);
  assert.ok(Math.abs(snap.atrPct! - 1) < 1e-6); // TR=1 при цене 100
});

test("snapshotAt: короткая история — null у длинных индикаторов, без падений", () => {
  const candles = Array.from({ length: 30 }, (_, i) => candle(i, 100 + i * 0.1));
  const snap = snapshotAt(candles, 29);
  assert.equal(snap.ema200, null);
  assert.equal(snap.priceToEma200Pct, null);
  assert.notEqual(snap.ema21, null);
  assert.notEqual(snap.rsi14, null);
});

test("computeExcursions: MAE/MFE от экстремумов свечей внутри сделки, в R", () => {
  const candles = [
    candle(0, 100, 101, 99),
    candle(1, 100, 103, 98), // внутри сделки: low 98 (−1R), high 103 (+1.5R)
    candle(2, 100, 106, 100), // внутри: high 106 (+3R)
    candle(3, 100, 120, 80), // после закрытия — не считается
  ];
  // Вход в момент открытия свечи 1, риск-дистанция 2, лонг; закрытие в свече 2.
  const result = computeExcursions(candles, "long", 100, 2, 1 * STEP, 2 * STEP + 30_000, STEP);
  assert.equal(result.maeR, 1);
  assert.equal(result.mfeRFromCandles, 3);

  const short = computeExcursions(candles, "short", 100, 2, 1 * STEP, 2 * STEP + 30_000, STEP);
  assert.equal(short.maeR, 3);
  assert.equal(short.mfeRFromCandles, 1);
});

test("computeExcursions: нет свечей в интервале — null", () => {
  const candles = [candle(0, 100)];
  const result = computeExcursions(candles, "long", 100, 2, 10 * STEP, 11 * STEP, STEP);
  assert.deepEqual(result, { maeR: null, mfeRFromCandles: null });
});

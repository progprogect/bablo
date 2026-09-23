import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "./indicators.js";
import {
  buildLevels,
  buildStructure,
  findConsolidationZones,
  findEngulfings,
  findStructureBreaks,
  findSwings,
  structureSnapshotAtEntry,
} from "./structure.js";

const STEP = 60_000;

function candle(i: number, close: number, high?: number, low?: number): Candle {
  return {
    time: i * STEP,
    open: close,
    high: high ?? close + 1,
    low: low ?? close - 1,
    close,
    volume: 100,
  };
}

test("findSwings: локальные экстремумы с крыльями, края не подтверждаются", () => {
  // Пила: пик на 3 (high 108), впадина на 6 (low 94).
  const closes = [100, 102, 104, 107, 104, 100, 95, 99, 102, 103];
  const candles = closes.map((c, i) => candle(i, c));
  const swings = findSwings(candles, 2);
  const highSwing = swings.find((s) => s.kind === "high");
  const lowSwing = swings.find((s) => s.kind === "low");
  assert.equal(highSwing?.index, 3);
  assert.equal(highSwing?.price, 108);
  assert.equal(lowSwing?.index, 6);
  assert.equal(lowSwing?.price, 94);
});

test("buildLevels: близкие свинги сливаются в уровень с суммой касаний", () => {
  const swings = [
    { index: 1, time: 0, price: 100.1, kind: "high" as const },
    { index: 5, time: 0, price: 100.4, kind: "high" as const },
    { index: 9, time: 0, price: 99.9, kind: "low" as const },
    { index: 13, time: 0, price: 120, kind: "high" as const }, // одиночка — отсекается minTouches
  ];
  const levels = buildLevels(swings, 1, 2);
  assert.equal(levels.length, 1);
  assert.equal(levels[0]!.touches, 3);
  assert.equal(levels[0]!.kind, "mixed");
  assert.ok(Math.abs(levels[0]!.price - 100.133) < 0.01);
});

test("findConsolidationZones: боковик находится, тренд — нет", () => {
  // 40 узких свечей боковика + 30 трендовых.
  const flat = Array.from({ length: 40 }, (_, i) => candle(i, 100 + (i % 2) * 0.2, 100.5, 99.7));
  const trend = Array.from({ length: 30 }, (_, i) => candle(40 + i, 103 + i * 2, 104 + i * 2, 102 + i * 2));
  const zones = findConsolidationZones([...flat, ...trend], { window: 20 });
  assert.equal(zones.length, 1);
  assert.equal(zones[0]!.fromTime, 0);
  assert.ok(zones[0]!.high <= 101 && zones[0]!.low >= 99);
});

test("findStructureBreaks: закрытие за свингом даёт слом в нужную сторону", () => {
  // Свинг-хай на index 3 (high 108), потом закрытие 110 на index 8 → слом вверх.
  const closes = [100, 102, 104, 107, 104, 100, 103, 105, 110, 111];
  const candles = closes.map((c, i) => candle(i, c));
  const swings = findSwings(candles, 2);
  const breaks = findStructureBreaks(candles, swings);
  const up = breaks.find((b) => b.direction === "up");
  assert.ok(up);
  assert.equal(up!.price, 108);
  assert.equal(up!.time, 8 * STEP);
});

test("structureSnapshotAtEntry: последний BOS до входа и вход в зоне", () => {
  const flat = Array.from({ length: 40 }, (_, i) => candle(i, 100 + (i % 2) * 0.2, 100.5, 99.7));
  const snapshot = structureSnapshotAtEntry(flat, STEP, 30 * STEP, 100);
  assert.equal(snapshot.entryInsideZone, true);
  assert.equal(snapshot.lastBosBeforeEntry, null); // в боковике сломов нет
});

test("buildStructure: на короткой истории пусто и не падает", () => {
  const candles = Array.from({ length: 10 }, (_, i) => candle(i, 100));
  assert.deepEqual(buildStructure(candles), { levels: [], zones: [], breaks: [], engulfings: [] });
});

test("findEngulfings: зелёная поглотила красную → bull, и наоборот", () => {
  const mk = (i: number, open: number, close: number): Candle => ({
    time: i * STEP,
    open,
    close,
    high: Math.max(open, close) + 0.5,
    low: Math.min(open, close) - 0.5,
    volume: 100,
  });
  const candles = [
    mk(0, 101, 100), // красная, тело 1
    mk(1, 99.5, 101.5), // зелёная, тело 2, перекрывает → bull
    mk(2, 101, 102), // зелёная
    mk(3, 102.5, 100.5), // красная, перекрывает → bear
    mk(4, 100.5, 100.8), // маленькая зелёная — тело НЕ больше предыдущего, не считается
  ];
  const found = findEngulfings(candles);
  assert.deepEqual(
    found.map((e) => [e.index, e.direction]),
    [
      [1, "bull"],
      [3, "bear"],
    ],
  );
});

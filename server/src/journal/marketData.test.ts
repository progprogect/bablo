import { test } from "node:test";
import assert from "node:assert/strict";
import { computeExtendedFromMs, EXTEND_MAX_DEPTH_MS, JOURNAL_CANDLE_INTERVALS } from "./marketData.js";

const DAY = 86_400_000;
const config15m = JOURNAL_CANDLE_INTERVALS.find((c) => c.key === "15m")!;

test("computeExtendedFromMs: шаг влево на beforeMs", () => {
  const opened = 1_000 * DAY;
  const from = opened - 3 * DAY; // базовое окно 15m
  assert.equal(computeExtendedFromMs(from, opened, config15m), from - 3 * DAY);
});

test("computeExtendedFromMs: упирается в потолок и затем null", () => {
  const opened = 1_000 * DAY;
  const floor = opened - EXTEND_MAX_DEPTH_MS["15m"];
  // Почти у потолка: остаток меньше шага — вернуть ровно потолок.
  const nearFloor = floor + DAY;
  assert.equal(computeExtendedFromMs(nearFloor, opened, config15m), floor);
  // На потолке — расширять некуда.
  assert.equal(computeExtendedFromMs(floor, opened, config15m), null);
});

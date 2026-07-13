import { test } from "node:test";
import assert from "node:assert/strict";
import { getNextResetAt, getTradingDayKey } from "./tradingDay.js";

const TZ = 180; // UTC+3
const RESET_HOUR = 7;

test("getTradingDayKey: до сброса относит момент к предыдущему дню", () => {
  // 2026-07-13T02:00:00Z = 05:00 UTC+3 — до 7 утра
  const key = getTradingDayKey(new Date("2026-07-13T02:00:00Z"), RESET_HOUR, TZ);
  assert.equal(key, "2026-07-12");
});

test("getTradingDayKey: после сброса относит момент к текущему дню", () => {
  // 2026-07-13T20:50:00Z = 23:50 UTC+3 — после 7 утра
  const key = getTradingDayKey(new Date("2026-07-13T20:50:00Z"), RESET_HOUR, TZ);
  assert.equal(key, "2026-07-13");
});

test("getTradingDayKey: ровно в момент сброса относит к новому дню", () => {
  // 2026-07-13T04:00:00Z = 07:00:00 UTC+3 ровно
  const key = getTradingDayKey(new Date("2026-07-13T04:00:00Z"), RESET_HOUR, TZ);
  assert.equal(key, "2026-07-13");
});

test("getNextResetAt: до сброса — сегодня в 07:00 локального времени", () => {
  const next = getNextResetAt(new Date("2026-07-13T02:00:00Z"), RESET_HOUR, TZ);
  assert.equal(next.toISOString(), "2026-07-13T04:00:00.000Z");
});

test("getNextResetAt: после сброса — завтра в 07:00 локального времени", () => {
  const next = getNextResetAt(new Date("2026-07-13T20:50:00Z"), RESET_HOUR, TZ);
  assert.equal(next.toISOString(), "2026-07-14T04:00:00.000Z");
});

test("getNextResetAt: ровно в момент сброса — переносится на следующий день", () => {
  const next = getNextResetAt(new Date("2026-07-13T04:00:00Z"), RESET_HOUR, TZ);
  assert.equal(next.toISOString(), "2026-07-14T04:00:00.000Z");
});

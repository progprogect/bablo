import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NIGHT_START_HOUR,
  getNextNightStartAt,
  getNightStartAtOrBefore,
  isDayTradeIntoNight,
  isLocalNight,
} from "./tradingDay.js";

const TZ = 180; // UTC+3 = МСК
const RESET = 7;
const NIGHT = DEFAULT_NIGHT_START_HOUR; // 23

test("DEFAULT_NIGHT_START_HOUR — 23:00 МСК", () => {
  assert.equal(DEFAULT_NIGHT_START_HOUR, 23);
});

test("isLocalNight: 23:00–06:59 — ночь, 07:00–22:59 — нет", () => {
  // 23:00 UTC+3 = 20:00Z
  assert.equal(isLocalNight(new Date("2026-07-14T20:00:00Z"), NIGHT, RESET, TZ), true);
  // 00:30 UTC+3
  assert.equal(isLocalNight(new Date("2026-07-13T21:30:00Z"), NIGHT, RESET, TZ), true);
  // 06:59 UTC+3
  assert.equal(isLocalNight(new Date("2026-07-14T03:59:00Z"), NIGHT, RESET, TZ), true);
  // 07:00 UTC+3
  assert.equal(isLocalNight(new Date("2026-07-14T04:00:00Z"), NIGHT, RESET, TZ), false);
  // 15:00 UTC+3
  assert.equal(isLocalNight(new Date("2026-07-14T12:00:00Z"), NIGHT, RESET, TZ), false);
  // 22:50 UTC+3 — ещё вечер, не ночь
  assert.equal(isLocalNight(new Date("2026-07-14T19:50:00Z"), NIGHT, RESET, TZ), false);
});

test("getNightStartAtOrBefore / getNextNightStartAt при старте 23:00", () => {
  // 15:00 UTC+3 → предыдущие 23:00 (вчера)
  const afternoon = new Date("2026-07-14T12:00:00Z");
  assert.equal(getNightStartAtOrBefore(afternoon, NIGHT, TZ).toISOString(), "2026-07-13T20:00:00.000Z");
  assert.equal(getNextNightStartAt(afternoon, NIGHT, TZ).toISOString(), "2026-07-14T20:00:00.000Z");

  // 01:00 UTC+3 → текущая ночь началась в 23:00 предыдущего календарного дня
  const night = new Date("2026-07-13T22:00:00Z"); // 01:00 14-го
  assert.equal(getNightStartAtOrBefore(night, NIGHT, TZ).toISOString(), "2026-07-13T20:00:00.000Z");
  assert.equal(getNextNightStartAt(night, NIGHT, TZ).toISOString(), "2026-07-14T20:00:00.000Z");
});

test("isDayTradeIntoNight: дневная сделка после 23:00 — да; открытая ночью — нет", () => {
  const openedDay = new Date("2026-07-14T10:00:00Z"); // 13:00 UTC+3
  const nowNight = new Date("2026-07-14T20:30:00Z"); // 23:30 UTC+3
  assert.equal(isDayTradeIntoNight(openedDay, nowNight, NIGHT, RESET, TZ), true);

  // 01:30 после полуночи — тоже ночь, дневная сделка всё ещё кандидат
  const afterMidnight = new Date("2026-07-14T22:30:00Z"); // 01:30
  assert.equal(isDayTradeIntoNight(openedDay, afterMidnight, NIGHT, RESET, TZ), true);

  const openedNight = new Date("2026-07-14T20:15:00Z"); // 23:15 — уже ночь
  assert.equal(isDayTradeIntoNight(openedNight, nowNight, NIGHT, RESET, TZ), false);

  const nowDay = new Date("2026-07-14T12:00:00Z"); // 15:00
  assert.equal(isDayTradeIntoNight(openedDay, nowDay, NIGHT, RESET, TZ), false);
});

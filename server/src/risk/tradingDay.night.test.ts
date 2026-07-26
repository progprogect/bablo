import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getNextNightStartAt,
  getNightStartAtOrBefore,
  isDayTradeIntoNight,
  isLocalNight,
} from "./tradingDay.js";

const TZ = 180; // UTC+3
const RESET = 7;
const NIGHT = 0;

test("isLocalNight: 00:00–06:59 — ночь, 07:00+ — нет", () => {
  // 00:30 UTC+3 = 2026-07-13T21:30:00Z prev day
  assert.equal(isLocalNight(new Date("2026-07-13T21:30:00Z"), NIGHT, RESET, TZ), true);
  // 06:59 UTC+3
  assert.equal(isLocalNight(new Date("2026-07-14T03:59:00Z"), NIGHT, RESET, TZ), true);
  // 07:00 UTC+3
  assert.equal(isLocalNight(new Date("2026-07-14T04:00:00Z"), NIGHT, RESET, TZ), false);
  // 15:00 UTC+3
  assert.equal(isLocalNight(new Date("2026-07-14T12:00:00Z"), NIGHT, RESET, TZ), false);
  // 23:50 UTC+3 — ещё вечер, не ночь
  assert.equal(isLocalNight(new Date("2026-07-14T20:50:00Z"), NIGHT, RESET, TZ), false);
});

test("getNightStartAtOrBefore / getNextNightStartAt", () => {
  // 15:00 UTC+3 → предыдущая полночь 00:00 того же календарного дня
  const afternoon = new Date("2026-07-14T12:00:00Z");
  assert.equal(getNightStartAtOrBefore(afternoon, NIGHT, TZ).toISOString(), "2026-07-13T21:00:00.000Z");
  assert.equal(getNextNightStartAt(afternoon, NIGHT, TZ).toISOString(), "2026-07-14T21:00:00.000Z");

  // 01:00 UTC+3 → текущая ночь началась в 00:00
  const night = new Date("2026-07-13T22:00:00Z");
  assert.equal(getNightStartAtOrBefore(night, NIGHT, TZ).toISOString(), "2026-07-13T21:00:00.000Z");
  assert.equal(getNextNightStartAt(night, NIGHT, TZ).toISOString(), "2026-07-14T21:00:00.000Z");
});

test("isDayTradeIntoNight: дневная сделка ночью — да; ночная — нет", () => {
  const openedDay = new Date("2026-07-14T10:00:00Z"); // 13:00 UTC+3
  const nowNight = new Date("2026-07-14T22:30:00Z"); // 01:30 UTC+3 next calendar... wait
  // 2026-07-14T22:30Z = 01:30 UTC+3 on July 15
  assert.equal(isDayTradeIntoNight(openedDay, nowNight, NIGHT, RESET, TZ), true);

  const openedNight = new Date("2026-07-14T22:00:00Z"); // 01:00 UTC+3 July 15
  assert.equal(isDayTradeIntoNight(openedNight, nowNight, NIGHT, RESET, TZ), false);

  const nowDay = new Date("2026-07-14T12:00:00Z"); // 15:00
  assert.equal(isDayTradeIntoNight(openedDay, nowDay, NIGHT, RESET, TZ), false);
});

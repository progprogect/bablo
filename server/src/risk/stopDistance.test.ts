import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkStopDistance,
  formatPct,
  stopDistancePct,
  stopDistanceRejectMessage,
} from "./stopDistance.js";

const LIMITS = { enabled: true, minPct: 0.8, maxPct: 3 };

test("stopDistancePct: база — цена входа, как в TradingView", () => {
  // Числа со скриншота пользователя: 0,6782 → 0,6765 у TradingView подписано как 0,251%.
  // Округление до сотых даёт 0,25%.
  assert.equal(stopDistancePct(0.6782, 0.6765), 0.25);
  // Второе плечо того же инструмента: 0,6782 → 0,6803 = 0,310% → 0,31%.
  assert.equal(stopDistancePct(0.6782, 0.6803), 0.31);
});

test("stopDistancePct: лонг и шорт на одинаковом разрыве дают один процент", () => {
  const entry = 100;
  // Стоп ниже входа (лонг) и выше входа (шорт) на одинаковые 2 единицы.
  assert.equal(stopDistancePct(entry, 98), 2);
  assert.equal(stopDistancePct(entry, 102), 2);
});

test("stopDistancePct: нет данных для расчёта — null, а не ноль", () => {
  assert.equal(stopDistancePct(0, 10), null);
  assert.equal(stopDistancePct(100, 0), null);
  assert.equal(stopDistancePct(Number.NaN, 10), null);
  assert.equal(stopDistancePct(100, Number.NaN), null);
});

test("checkStopDistance: внутри границ — ok с процентом", () => {
  const long = checkStopDistance({ side: "long", entryPrice: 100, slPrice: 98.76, limits: LIMITS });
  assert.deepEqual(long, { status: "ok", pct: 1.24 });
  const short = checkStopDistance({ side: "short", entryPrice: 100, slPrice: 101.24, limits: LIMITS });
  assert.deepEqual(short, { status: "ok", pct: 1.24 });
});

test("checkStopDistance: стоп ближе минимума — подсказка зеркальна по стороне", () => {
  // Лонг: отодвинуть стоп дальше от входа — значит ВНИЗ, к 99.2 (100 − 0.8%).
  const long = checkStopDistance({ side: "long", entryPrice: 100, slPrice: 99.6, limits: LIMITS });
  assert.deepEqual(long, { status: "too_close", pct: 0.4, limitPct: 0.8, suggestedSl: 99.2 });

  // Шорт: тот же разрыв, но дальше от входа — ВВЕРХ, к 100.8.
  const short = checkStopDistance({ side: "short", entryPrice: 100, slPrice: 100.4, limits: LIMITS });
  assert.deepEqual(short, { status: "too_close", pct: 0.4, limitPct: 0.8, suggestedSl: 100.8 });
});

test("checkStopDistance: стоп дальше максимума — подсказка тоже зеркальна", () => {
  // Лонг: приблизить стоп к входу — значит ВВЕРХ, к 97 (100 − 3%).
  const long = checkStopDistance({ side: "long", entryPrice: 100, slPrice: 95.9, limits: LIMITS });
  assert.deepEqual(long, { status: "too_far", pct: 4.1, limitPct: 3, suggestedSl: 97 });

  // Шорт: приблизить — значит ВНИЗ, к 103.
  const short = checkStopDistance({ side: "short", entryPrice: 100, slPrice: 104.1, limits: LIMITS });
  assert.deepEqual(short, { status: "too_far", pct: 4.1, limitPct: 3, suggestedSl: 103 });
});

test("checkStopDistance: ровно на границе — проходит", () => {
  assert.deepEqual(
    checkStopDistance({ side: "long", entryPrice: 100, slPrice: 99.2, limits: LIMITS }),
    { status: "ok", pct: 0.8 },
  );
  assert.deepEqual(
    checkStopDistance({ side: "long", entryPrice: 100, slPrice: 97, limits: LIMITS }),
    { status: "ok", pct: 3 },
  );
});

test("checkStopDistance: сравнение идёт по ОКРУГЛЁННОМУ проценту", () => {
  // 0.7996% округляется до 0,80% — именно это число видит пользователь, и блокировать
  // его минимумом 0,80% нельзя: на экране «0,80%» против «минимум 0,80%».
  const decision = checkStopDistance({
    side: "long",
    entryPrice: 100,
    slPrice: 99.2004,
    limits: LIMITS,
  });
  assert.deepEqual(decision, { status: "ok", pct: 0.8 });
});

test("checkStopDistance: выключенная проверка не мешает входу", () => {
  const decision = checkStopDistance({
    side: "long",
    entryPrice: 100,
    slPrice: 99.9,
    limits: { enabled: false, minPct: 0.8, maxPct: 3 },
  });
  assert.deepEqual(decision, { status: "off" });
});

test("checkStopDistance: включена, но границы не заданы — тоже off", () => {
  const decision = checkStopDistance({
    side: "long",
    entryPrice: 100,
    slPrice: 99.9,
    limits: { enabled: true, minPct: null, maxPct: null },
  });
  assert.deepEqual(decision, { status: "off" });
});

test("checkStopDistance: одна граница задана — вторая не мешает", () => {
  const onlyMin = { enabled: true, minPct: 0.8, maxPct: null };
  assert.equal(
    checkStopDistance({ side: "long", entryPrice: 100, slPrice: 90, limits: onlyMin }).status,
    "ok",
  );
  assert.equal(
    checkStopDistance({ side: "long", entryPrice: 100, slPrice: 99.9, limits: onlyMin }).status,
    "too_close",
  );

  const onlyMax = { enabled: true, minPct: null, maxPct: 3 };
  assert.equal(
    checkStopDistance({ side: "long", entryPrice: 100, slPrice: 99.9, limits: onlyMax }).status,
    "ok",
  );
  assert.equal(
    checkStopDistance({ side: "long", entryPrice: 100, slPrice: 90, limits: onlyMax }).status,
    "too_far",
  );
});

test("formatPct: запятая и ровно две цифры", () => {
  assert.equal(formatPct(0.8), "0,80");
  assert.equal(formatPct(1.24), "1,24");
  assert.equal(formatPct(3), "3,00");
});

test("stopDistanceRejectMessage: обе формулировки", () => {
  assert.equal(
    stopDistanceRejectMessage({
      status: "too_close",
      pct: 0.41,
      limitPct: 0.8,
      suggestedSl: 0.6728,
    }),
    "Стоп в 0,41% от входа — ближе минимума 0,80%. Отодвиньте SL до ≈0.6728 или дальше.",
  );
  assert.equal(
    stopDistanceRejectMessage({ status: "too_far", pct: 4.1, limitPct: 3, suggestedSl: 0.6579 }),
    "Стоп в 4,10% от входа — дальше максимума 3,00%. Приблизьте SL до ≈0.6579 или ближе.",
  );
});

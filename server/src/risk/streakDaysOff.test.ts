import { test } from "node:test";
import assert from "node:assert/strict";
import type { TradeOutcome } from "../history/outcome.js";
import {
  buildStreakDayOffBlock,
  computeEdgeStopsTrigger,
  computeTakeStreakTrigger,
  EDGE_STOPS_REASON,
  TAKE_STREAK_REASON,
} from "./streakDaysOff.js";

const CONFIG = { resetHour: 7, tzOffsetMinutes: 180 };

function day(dayKey: string, ...outcomes: TradeOutcome[]) {
  return { dayKey, outcomes };
}

// --- Правило #20: пять тейков подряд ---

test("правило #20: пятый тейк подряд даёт срабатывание в свой день", () => {
  const days = [day("2026-10-05", "tp", "tp", "tp"), day("2026-10-06", "tp", "tp")];
  assert.deepEqual(computeTakeStreakTrigger(days), { dayKey: "2026-10-06" });
});

test("правило #20: четыре тейка — не срабатывает", () => {
  assert.equal(computeTakeStreakTrigger([day("2026-10-05", "tp", "tp", "tp", "tp")]), null);
});

test("правило #20: стоп обрывает серию", () => {
  const days = [day("2026-10-05", "tp", "tp", "tp", "sl"), day("2026-10-06", "tp", "tp", "tp", "tp")];
  assert.equal(computeTakeStreakTrigger(days), null);
});

test("правило #20: безубыток и прочие закрытия серию не обрывают и не считаются", () => {
  const days = [day("2026-10-05", "tp", "tp", "be", "tp"), day("2026-10-06", "other", "tp", "tp")];
  assert.deepEqual(computeTakeStreakTrigger(days), { dayKey: "2026-10-06" });
});

test("правило #20: после срабатывания серия считается заново («каждый раз»)", () => {
  // 5 тейков → срабатывание; дальше 4 тейка — нового срабатывания ещё нет.
  const nine = [day("2026-10-05", "tp", "tp", "tp", "tp", "tp", "tp", "tp", "tp", "tp")];
  assert.deepEqual(computeTakeStreakTrigger(nine), { dayKey: "2026-10-05" });
  // Десятый тейк — второе срабатывание, день его же.
  const ten = [day("2026-10-05", ...Array<TradeOutcome>(10).fill("tp"))];
  assert.deepEqual(computeTakeStreakTrigger(ten), { dayKey: "2026-10-05" });
});

// --- Правило #21: стопы на стыке дней ---

test("правило #21: крайний стоп вчера и первый стоп сегодня — срабатывает", () => {
  const days = [day("2026-10-05", "tp", "sl"), day("2026-10-06", "sl")];
  assert.deepEqual(computeEdgeStopsTrigger(days, "2026-10-06"), { dayKey: "2026-10-06" });
});

test("правило #21: предыдущий день торговли ищется по сделкам, а не по календарю", () => {
  // Между днями разрыв (выходной/паузы) — считается последний день СО СДЕЛКАМИ.
  const days = [day("2026-10-03", "sl"), day("2026-10-06", "sl", "tp")];
  assert.deepEqual(computeEdgeStopsTrigger(days, "2026-10-06"), { dayKey: "2026-10-06" });
});

test("правило #21: не срабатывает, если край — не стоп", () => {
  // Вчера закончили тейком.
  assert.equal(
    computeEdgeStopsTrigger([day("2026-10-05", "sl", "tp"), day("2026-10-06", "sl")], "2026-10-06"),
    null,
  );
  // Сегодня первая — безубыток, стоп лишь второй.
  assert.equal(
    computeEdgeStopsTrigger([day("2026-10-05", "sl"), day("2026-10-06", "be", "sl")], "2026-10-06"),
    null,
  );
  // Первого дня торговли вообще не было.
  assert.equal(computeEdgeStopsTrigger([day("2026-10-06", "sl")], "2026-10-06"), null);
  // Сегодня сделок ещё нет.
  assert.equal(computeEdgeStopsTrigger([day("2026-10-05", "sl")], "2026-10-06"), null);
});

// --- Блокировка: день закрыт + следующий выходной ---

test("блок: действует до сброса ПОСЛЕзавтрашнего дня, потом исчезает", () => {
  const trigger = { dayKey: "2026-10-05" };
  // 05.10 — день срабатывания; закрыт он сам и весь 06.10; открытие — 07.10 в 07:00 МСК (04:00Z).
  const active = buildStreakDayOffBlock(
    new Date("2026-10-05T12:00:00Z"),
    trigger,
    { type: "take_streak", reason: TAKE_STREAK_REASON },
    CONFIG,
  );
  assert.ok(active);
  assert.equal(active.type, "take_streak");
  assert.equal(active.reason, TAKE_STREAK_REASON);
  assert.deepEqual(active.until, new Date("2026-10-07T04:00:00Z"));

  // Выходной прошёл — блока нет: «потом продолжаем торговлю как обычно».
  assert.equal(
    buildStreakDayOffBlock(
      new Date("2026-10-07T05:00:00Z"),
      trigger,
      { type: "take_streak", reason: TAKE_STREAK_REASON },
      CONFIG,
    ),
    null,
  );
});

test("блок: без срабатывания — null; тексты помещаются в плашку", () => {
  assert.equal(
    buildStreakDayOffBlock(new Date(), null, { type: "edge_stops", reason: EDGE_STOPS_REASON }, CONFIG),
    null,
  );
  assert.ok(TAKE_STREAK_REASON.length <= 60);
  assert.ok(EDGE_STOPS_REASON.length <= 60);
});

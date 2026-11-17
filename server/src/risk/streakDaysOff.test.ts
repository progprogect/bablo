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

/**
 * Дата включения для сценариев: правила не смотрят на сделки до STREAK_RULES_SINCE_DAY
 * (реальная дата — 17.11.2026), а сценарии написаны на октябрьских числах. Отдельные
 * тесты на отсечку — в конце файла, на настоящей константе.
 */
const SINCE = "2026-10-01";
const takeTrigger = (days: ReturnType<typeof day>[]) => computeTakeStreakTrigger(days, SINCE);
const edgeTrigger = (days: ReturnType<typeof day>[], todayKey: string) =>
  computeEdgeStopsTrigger(days, todayKey, SINCE);

function day(dayKey: string, ...outcomes: TradeOutcome[]) {
  return { dayKey, outcomes };
}

// --- Правило #20: пять тейков подряд ---

test("правило #20: пятый тейк подряд даёт срабатывание в свой день", () => {
  const days = [day("2026-10-05", "tp", "tp", "tp"), day("2026-10-06", "tp", "tp")];
  assert.deepEqual(takeTrigger(days), { dayKey: "2026-10-06" });
});

test("правило #20: четыре тейка — не срабатывает", () => {
  assert.equal(takeTrigger([day("2026-10-05", "tp", "tp", "tp", "tp")]), null);
});

test("правило #20: стоп обрывает серию", () => {
  const days = [day("2026-10-05", "tp", "tp", "tp", "sl"), day("2026-10-06", "tp", "tp", "tp", "tp")];
  assert.equal(takeTrigger(days), null);
});

test("правило #20: безубыток и прочие закрытия серию не обрывают и не считаются", () => {
  const days = [day("2026-10-05", "tp", "tp", "be", "tp"), day("2026-10-06", "other", "tp", "tp")];
  assert.deepEqual(takeTrigger(days), { dayKey: "2026-10-06" });
});

test("правило #20: после срабатывания серия считается заново («каждый раз»)", () => {
  // 5 тейков → срабатывание; дальше 4 тейка — нового срабатывания ещё нет.
  const nine = [day("2026-10-05", "tp", "tp", "tp", "tp", "tp", "tp", "tp", "tp", "tp")];
  assert.deepEqual(takeTrigger(nine), { dayKey: "2026-10-05" });
  // Десятый тейк — второе срабатывание, день его же.
  const ten = [day("2026-10-05", ...Array<TradeOutcome>(10).fill("tp"))];
  assert.deepEqual(takeTrigger(ten), { dayKey: "2026-10-05" });
});

// --- Правило #21: стопы на стыке дней ---

test("правило #21: крайний стоп вчера и первый стоп сегодня — срабатывает", () => {
  const days = [day("2026-10-05", "tp", "sl"), day("2026-10-06", "sl")];
  assert.deepEqual(edgeTrigger(days, "2026-10-06"), { dayKey: "2026-10-06" });
});

test("правило #21: предыдущий день торговли ищется по сделкам, а не по календарю", () => {
  // Между днями разрыв (выходной/паузы) — считается последний день СО СДЕЛКАМИ.
  const days = [day("2026-10-03", "sl"), day("2026-10-06", "sl", "tp")];
  assert.deepEqual(edgeTrigger(days, "2026-10-06"), { dayKey: "2026-10-06" });
});

test("правило #21: не срабатывает, если край — не стоп", () => {
  // Вчера закончили тейком.
  assert.equal(
    edgeTrigger([day("2026-10-05", "sl", "tp"), day("2026-10-06", "sl")], "2026-10-06"),
    null,
  );
  // Сегодня первая — безубыток, стоп лишь второй.
  assert.equal(
    edgeTrigger([day("2026-10-05", "sl"), day("2026-10-06", "be", "sl")], "2026-10-06"),
    null,
  );
  // Первого дня торговли вообще не было.
  assert.equal(edgeTrigger([day("2026-10-06", "sl")], "2026-10-06"), null);
  // Сегодня сделок ещё нет.
  assert.equal(edgeTrigger([day("2026-10-05", "sl")], "2026-10-06"), null);
});

test("правило #21: серия по дням пользователя — 2-й день блок, 3-й выходной, стоп в 4-й день даёт 5-й выходной", () => {
  // День 1 (05.10): крайняя сделка по стопу — первый потенциальный день серии.
  // День 2 (06.10): первая сделка по стопу → серия подтверждена, день закрыт.
  // День 3 (07.10): выходной — сделок нет, в списке дней его просто нет.
  // День 4 (08.10): первая сделка снова по стопу → день закрыт…
  // День 5 (09.10): …и снова выходной. Дальше торговля как обычно.
  const days = [day("2026-10-05", "tp", "sl"), day("2026-10-06", "sl"), day("2026-10-08", "sl")];

  // Второй день серии: срабатывание.
  assert.deepEqual(edgeTrigger(days.slice(0, 2), "2026-10-06"), { dayKey: "2026-10-06" });
  const dayTwoBlock = buildStreakDayOffBlock(
    new Date("2026-10-06T09:00:00Z"),
    edgeTrigger(days.slice(0, 2), "2026-10-06"),
    { type: "edge_stops", reason: EDGE_STOPS_REASON },
    CONFIG,
  );
  // Закрыт сам день 2 и весь день 3; открытие — 08.10 в 07:00 МСК (04:00Z).
  assert.deepEqual(dayTwoBlock?.until, new Date("2026-10-08T04:00:00Z"));

  // Четвёртый день серии: предыдущий день СО СДЕЛКАМИ — это день 2, его крайняя — стоп.
  assert.deepEqual(edgeTrigger(days, "2026-10-08"), { dayKey: "2026-10-08" });
  const dayFourBlock = buildStreakDayOffBlock(
    new Date("2026-10-08T09:00:00Z"),
    edgeTrigger(days, "2026-10-08"),
    { type: "edge_stops", reason: EDGE_STOPS_REASON },
    CONFIG,
  );
  // Закрыт день 4 и весь день 5; открытие — 10.10 в 07:00 МСК.
  assert.deepEqual(dayFourBlock?.until, new Date("2026-10-10T04:00:00Z"));
});

test("правило #21: тейк первой сделкой после выходного обрывает серию", () => {
  const days = [day("2026-10-05", "tp", "sl"), day("2026-10-06", "sl"), day("2026-10-08", "tp", "sl")];
  assert.equal(edgeTrigger(days, "2026-10-08"), null);
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

// --- Отсечка по дате включения правил (замечание пользователя от 17.11.2026) ---

test("правила не срабатывают задним числом: сделки до даты включения не считаются", () => {
  // Серия сложилась ДО включения правил (16.11 — крайний стоп, 17.11 — первый стоп):
  // день до включения «предыдущим днём торговли» не считается.
  const edge = [day("2026-11-16", "tp", "sl"), day("2026-11-17", "sl")];
  assert.equal(computeEdgeStopsTrigger(edge, "2026-11-17"), null);

  // Тейки до даты включения в серию не входят: 4 старых + 1 новый — не пять подряд.
  const takes = [day("2026-11-16", "tp", "tp", "tp", "tp"), day("2026-11-17", "tp")];
  assert.equal(computeTakeStreakTrigger(takes), null);
});

test("с даты включения правила работают как обычно", () => {
  assert.deepEqual(
    computeEdgeStopsTrigger([day("2026-11-17", "tp", "sl"), day("2026-11-18", "sl")], "2026-11-18"),
    { dayKey: "2026-11-18" },
  );
  assert.deepEqual(
    computeTakeStreakTrigger([day("2026-11-17", "tp", "tp", "tp"), day("2026-11-18", "tp", "tp")]),
    { dayKey: "2026-11-18" },
  );
});

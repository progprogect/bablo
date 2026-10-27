import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStopChainBlock,
  computeStopChain,
  dayStopLimitForStage,
  type StopChainDay,
} from "./stopChain.js";
import { getResetAtAfterTradingDay } from "./tradingDay.js";
import type { TradeOutcome } from "../history/outcome.js";

const CONFIG = { cooldownMinutes: 60, dailyLossLimitR: -2, dailyProfitLimitR: 3, resetHour: 7, tzOffsetMinutes: 180 };

function day(dayKey: string, ...outcomes: TradeOutcome[]): StopChainDay {
  return { dayKey, outcomes };
}

test("dayStopLimitForStage: без серии два стопа, внутри серии один", () => {
  assert.equal(dayStopLimitForStage(0), 2);
  assert.equal(dayStopLimitForStage(1), 1);
  assert.equal(dayStopLimitForStage(7), 1);
});

test("пустая история — серии нет, лимит обычный", () => {
  const state = computeStopChain([], "2026-07-13");
  assert.equal(state.stage, 0);
  assert.equal(state.todayStopLimit, 2);
  assert.equal(state.triggeredDayKey, null);
  assert.equal(state.blockedFullDays, 0);
});

test("один стоп за день серию не начинает", () => {
  const state = computeStopChain([day("2026-07-13", "sl")], "2026-07-13");
  assert.equal(state.stage, 0);
  assert.equal(state.todayStopLimit, 2);
  assert.equal(state.triggeredDayKey, null);
});

test("два стопа за день — ступень 1, полных дней паузы нет", () => {
  const state = computeStopChain([day("2026-07-13", "sl", "sl")], "2026-07-13");
  assert.equal(state.stage, 1);
  assert.equal(state.triggeredDayKey, "2026-07-13");
  assert.equal(state.blockedFullDays, 0);
  // Сегодняшний лимит считается по ступени на НАЧАЛО дня — сегодня он был ещё 2.
  assert.equal(state.todayStopLimit, 2);
  // Отдельного лока на полные дни нет: день закрывает обычный daily_stop_losses.
  assert.equal(buildStopChainBlock(new Date("2026-07-13T15:00:00Z"), state, CONFIG), null);
});

test("на следующий день хватает одного стопа — пауза на 1 полный день", () => {
  const days = [day("2026-07-13", "sl", "sl"), day("2026-07-14", "sl")];
  const state = computeStopChain(days, "2026-07-14");
  assert.equal(state.stage, 2);
  assert.equal(state.todayStopLimit, 1);
  assert.equal(state.triggeredDayKey, "2026-07-14");
  assert.equal(state.blockedFullDays, 1);

  const block = buildStopChainBlock(new Date("2026-07-14T20:00:00Z"), state, CONFIG);
  assert.ok(block);
  assert.equal(block?.type, "stop_chain");
  // День 14-го кончается сбросом 15-го в 07:00 МСК, плюс один полный день → 16-е 07:00 МСК.
  assert.equal(block?.until.toISOString(), "2026-07-16T04:00:00.000Z");
});

// Правка 27.10.2026: выходной не растёт со ступенью — он всегда один.
test("дальше по серии выходной остаётся один, а не копится", () => {
  const third = computeStopChain(
    [day("2026-07-13", "sl", "sl"), day("2026-07-14", "sl"), day("2026-07-17", "sl")],
    "2026-07-17",
  );
  assert.equal(third.stage, 3);
  assert.equal(third.blockedFullDays, 1);
  assert.equal(third.triggeredDayKey, "2026-07-17");

  const fourth = computeStopChain(
    [
      day("2026-07-13", "sl", "sl"),
      day("2026-07-14", "sl"),
      day("2026-07-17", "sl"),
      day("2026-07-21", "sl"),
    ],
    "2026-07-21",
  );
  assert.equal(fourth.stage, 4);
  assert.equal(fourth.blockedFullDays, 1);

  // Пауза в календаре тоже ровно один день: день 21-го кончается сбросом 22-го в 07:00
  // МСК, плюс один полный день → 23-е 07:00 МСК.
  const block = buildStopChainBlock(new Date("2026-07-21T20:00:00Z"), fourth, CONFIG);
  assert.equal(block?.until.toISOString(), "2026-07-23T04:00:00.000Z");
});

test("тейк обнуляет лестницу целиком", () => {
  const days = [day("2026-07-13", "sl", "sl"), day("2026-07-14", "sl"), day("2026-07-17", "tp")];
  const state = computeStopChain(days, "2026-07-17");
  assert.equal(state.stage, 0);
  assert.equal(state.todayStopLimit, 1, "лимит дня считается по ступени на его начало");
  assert.equal(state.triggeredDayKey, null);
  assert.equal(state.blockedFullDays, 0);
  assert.equal(buildStopChainBlock(new Date("2026-07-17T15:00:00Z"), state, CONFIG), null);

  // Следующий день после тейка — уже обычный, два стопа.
  const next = computeStopChain([...days], "2026-07-18");
  assert.equal(next.todayStopLimit, 2);
});

test("стопы считаются подряд: SL → TP → SL за день ступень не поднимает", () => {
  const state = computeStopChain([day("2026-07-13", "sl", "tp", "sl")], "2026-07-13");
  assert.equal(state.stage, 0);
  assert.equal(state.triggeredDayKey, null);
});

test("безубыток и ручное закрытие стопами не считаются и серию не обнуляют", () => {
  const state = computeStopChain([day("2026-07-13", "be", "sl", "other", "sl")], "2026-07-13");
  assert.equal(state.stage, 1, "два стопа подряд, БУ и ручное между ними не мешают");
  assert.equal(state.triggeredDayKey, "2026-07-13");

  const inChain = computeStopChain(
    [day("2026-07-13", "sl", "sl"), day("2026-07-14", "be", "other")],
    "2026-07-14",
  );
  assert.equal(inChain.stage, 1, "БУ и ручное закрытие серию не обнуляют");
  assert.equal(inChain.todayStopLimit, 1);
});

test("день без сделок лимит не сбрасывает: ступень живёт до тейка", () => {
  const days = [day("2026-07-13", "sl", "sl"), day("2026-07-14", "sl")];
  const state = computeStopChain(days, "2026-07-25");
  assert.equal(state.stage, 2);
  assert.equal(state.todayStopLimit, 1, "через неделю без сделок серия всё ещё активна");
});

test("buildStopChainBlock: пауза истекла — блока нет", () => {
  const state = computeStopChain(
    [day("2026-07-13", "sl", "sl"), day("2026-07-14", "sl")],
    "2026-07-14",
  );
  assert.equal(buildStopChainBlock(new Date("2026-07-16T04:00:00Z"), state, CONFIG), null);
  assert.ok(buildStopChainBlock(new Date("2026-07-16T03:59:00Z"), state, CONFIG));
});

test("buildStopChainBlock: причина говорит про один выходной и помещается в плашку", () => {
  const state = computeStopChain(
    [day("2026-07-13", "sl", "sl"), day("2026-07-14", "sl")],
    "2026-07-14",
  );
  const block = buildStopChainBlock(new Date("2026-07-14T20:00:00Z"), state, CONFIG);
  assert.ok(block);
  assert.equal(block.reason, "Серия стопов — пауза ещё на день. Тейк обнулит серию");
  assert.ok(block.reason.length <= 60);
});

test("getResetAtAfterTradingDay: конец дня и полные дни сверху", () => {
  // Торговый день 13.07 заканчивается сбросом 14.07 в 07:00 МСК = 04:00 UTC.
  assert.equal(
    getResetAtAfterTradingDay("2026-07-13", 0, 7, 180)?.toISOString(),
    "2026-07-14T04:00:00.000Z",
  );
  assert.equal(
    getResetAtAfterTradingDay("2026-07-13", 2, 7, 180)?.toISOString(),
    "2026-07-16T04:00:00.000Z",
  );
  // Переход через конец месяца.
  assert.equal(
    getResetAtAfterTradingDay("2026-07-31", 1, 7, 180)?.toISOString(),
    "2026-08-02T04:00:00.000Z",
  );
  assert.equal(getResetAtAfterTradingDay("не дата", 0, 7, 180), null);
});

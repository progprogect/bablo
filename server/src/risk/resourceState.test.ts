import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveResourceState, type ResourceStateInput } from "./resourceState.js";

const TODAY = "2026-09-18";
const COOLDOWN_MINUTES = 60;

function at(hour: number, minutes = 0): Date {
  return new Date(Date.UTC(2026, 8, 18, hour, minutes, 0));
}

function input(overrides: Partial<ResourceStateInput> = {}): ResourceStateInput {
  return {
    stored: null,
    todayKey: TODAY,
    now: at(12),
    lastTradeClosedAt: null,
    cooldownMinutes: COOLDOWN_MINUTES,
    ...overrides,
  };
}

function answeredAt(hour: number, minutes = 0, isResourceful = true) {
  return { dayKey: TODAY, isResourceful, answeredAt: at(hour, minutes).toISOString() };
}

test("resolveResourceState: ответа ещё не было — спрашиваем как за новый день", () => {
  assert.deepEqual(resolveResourceState(input()), {
    dayKey: TODAY,
    answered: false,
    isResourceful: null,
    askReason: "day",
  });
});

test("resolveResourceState: ответ за сегодня, сделок не было — больше не спрашиваем", () => {
  assert.deepEqual(resolveResourceState(input({ stored: answeredAt(9) })), {
    dayKey: TODAY,
    answered: true,
    isResourceful: true,
    askReason: null,
  });
});

test("resolveResourceState: ответ прошлого дня — новый день спрашивает заново", () => {
  const stored = { dayKey: "2026-09-17", isResourceful: false, answeredAt: at(9).toISOString() };
  assert.deepEqual(resolveResourceState(input({ stored })), {
    dayKey: TODAY,
    answered: false,
    isResourceful: null,
    askReason: "day",
  });
});

test("resolveResourceState: «не в ресурсе» помнится, пока не наступила новая точка", () => {
  const view = resolveResourceState(input({ stored: answeredAt(9, 0, false) }));
  assert.equal(view.answered, true);
  assert.equal(view.isResourceful, false);
});

// Правило от 18.09.2026: после каждого часового перерыва спрашиваем снова.
test("resolveResourceState: перерыв после сделки закончился — спрашиваем снова", () => {
  const view = resolveResourceState(
    input({
      stored: answeredAt(9), // ответ ДО закрытия сделки
      lastTradeClosedAt: at(10, 30), // перерыв до 11:30
      now: at(11, 31),
    }),
  );
  assert.deepEqual(view, { dayKey: TODAY, answered: false, isResourceful: null, askReason: "cooldown" });
});

test("resolveResourceState: перерыв ещё идёт — не спрашиваем", () => {
  const view = resolveResourceState(
    input({ stored: answeredAt(9), lastTradeClosedAt: at(10, 30), now: at(11, 0) }),
  );
  assert.equal(view.answered, true);
  assert.equal(view.askReason, null);
});

test("resolveResourceState: ответили уже после перерыва — второй раз не спрашиваем", () => {
  const view = resolveResourceState(
    input({ stored: answeredAt(11, 40), lastTradeClosedAt: at(10, 30), now: at(15) }),
  );
  assert.equal(view.answered, true);
});

test("resolveResourceState: новая сделка — новый перерыв — снова спрашиваем", () => {
  // Ответили в 11:40 после первого перерыва, затем закрылась ещё сделка в 13:00.
  const view = resolveResourceState(
    input({ stored: answeredAt(11, 40), lastTradeClosedAt: at(13), now: at(14, 5) }),
  );
  assert.equal(view.answered, false);
  assert.equal(view.askReason, "cooldown");
});

test("resolveResourceState: нулевой кулдаун — спрашиваем сразу после закрытия сделки", () => {
  const view = resolveResourceState(
    input({ stored: answeredAt(9), lastTradeClosedAt: at(10), now: at(10, 1), cooldownMinutes: 0 }),
  );
  assert.equal(view.askReason, "cooldown");
});

test("resolveResourceState: сделка закрыта ДО ответа — лишний вопрос не задаём", () => {
  const view = resolveResourceState(
    input({ stored: answeredAt(12), lastTradeClosedAt: at(9), now: at(12, 5) }),
  );
  assert.equal(view.answered, true);
});

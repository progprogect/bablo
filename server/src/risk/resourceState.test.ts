import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveResourceState } from "./resourceState.js";

const TODAY = "2026-09-16";

test("resolveResourceState: ответа ещё не было — спрашиваем", () => {
  assert.deepEqual(resolveResourceState(null, TODAY), {
    dayKey: TODAY,
    answered: false,
    isResourceful: null,
  });
});

test("resolveResourceState: ответ за сегодня — больше не спрашиваем", () => {
  const stored = { dayKey: TODAY, isResourceful: true, answeredAt: "2026-09-16T07:20:00.000Z" };
  assert.deepEqual(resolveResourceState(stored, TODAY), {
    dayKey: TODAY,
    answered: true,
    isResourceful: true,
  });
});

test("resolveResourceState: «не в ресурсе» помнится весь день", () => {
  const stored = { dayKey: TODAY, isResourceful: false, answeredAt: "2026-09-16T07:20:00.000Z" };
  assert.deepEqual(resolveResourceState(stored, TODAY), {
    dayKey: TODAY,
    answered: true,
    isResourceful: false,
  });
});

test("resolveResourceState: ответ прошлого дня не считается — новый день спрашивает заново", () => {
  const stored = { dayKey: "2026-09-15", isResourceful: false, answeredAt: "2026-09-15T08:00:00.000Z" };
  assert.deepEqual(resolveResourceState(stored, TODAY), {
    dayKey: TODAY,
    answered: false,
    isResourceful: null,
  });
});

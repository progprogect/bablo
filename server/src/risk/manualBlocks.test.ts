import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWindow,
  describeManualBlock,
  formatOpenMoment,
  hoursBlockedAt,
  MAX_HOUR_BLOCK_DAYS,
  openMomentAfter,
  validateHourBlockInput,
  type ManualBlock,
} from "./manualBlocks.js";

/** Таймзона риск-плана по умолчанию — МСК (UTC+3). */
const TZ = 180;

/** Момент «локальные часы:минуты» дня 2026-10-05 в реальном UTC. */
function atLocal(hour: number, minute = 0, day = 5): Date {
  return new Date(Date.UTC(2026, 9, day, hour, minute) - TZ * 60_000);
}

function hourBlock(hour: number, endsAt: Date): ManualBlock {
  return { kind: "hour", hour, endsAt };
}

function windowBlock(startsAt: Date, endsAt: Date): ManualBlock {
  return { kind: "window", startsAt, endsAt };
}

test("hoursBlockedAt: истёкшие блокировки часов не считаются", () => {
  const now = atLocal(12);
  const blocks = [
    hourBlock(9, atLocal(13)), // активна
    hourBlock(14, atLocal(11)), // истекла
  ];
  assert.deepEqual(hoursBlockedAt(now, blocks), [9]);
});

test("openMomentAfter: торговля открыта — null", () => {
  const now = atLocal(12, 30);
  const blocks = [hourBlock(9, atLocal(23)), windowBlock(atLocal(15), atLocal(16))];
  assert.equal(openMomentAfter(now, blocks, TZ), null);
});

test("openMomentAfter: закрытый час держит до границы часа", () => {
  const now = atLocal(9, 30);
  const blocks = [hourBlock(9, atLocal(9, 0, 12))]; // срок — через неделю
  assert.deepEqual(openMomentAfter(now, blocks, TZ), atLocal(10));
});

test("openMomentAfter: срок часа истекает внутри часа — открытие в момент истечения", () => {
  const now = atLocal(9, 10);
  const blocks = [hourBlock(9, atLocal(9, 40))];
  assert.deepEqual(openMomentAfter(now, blocks, TZ), atLocal(9, 40));
});

test("openMomentAfter: подряд закрытые часы схлопываются в одно ожидание", () => {
  const now = atLocal(9, 30);
  const blocks = [hourBlock(9, atLocal(9, 0, 12)), hourBlock(10, atLocal(9, 0, 12))];
  assert.deepEqual(openMomentAfter(now, blocks, TZ), atLocal(11));
});

test("openMomentAfter: активное окно держит до своего конца", () => {
  const now = atLocal(14, 10);
  const blocks = [windowBlock(atLocal(14), atLocal(18))];
  assert.deepEqual(openMomentAfter(now, blocks, TZ), atLocal(18));
});

test("openMomentAfter: окно, которое ещё не началось, сейчас не блокирует", () => {
  const now = atLocal(13, 59);
  const blocks = [windowBlock(atLocal(14), atLocal(18))];
  assert.equal(openMomentAfter(now, blocks, TZ), null);
});

test("openMomentAfter: час упирается в окно — ожидание продлевается до конца окна", () => {
  const now = atLocal(9, 30);
  const blocks = [hourBlock(9, atLocal(9, 0, 12)), windowBlock(atLocal(10), atLocal(12))];
  assert.deepEqual(openMomentAfter(now, blocks, TZ), atLocal(12));
});

test("openMomentAfter: окно кончается внутри закрытого часа — ждём и его", () => {
  const now = atLocal(9, 40);
  const blocks = [windowBlock(atLocal(9, 30), atLocal(10, 20)), hourBlock(10, atLocal(9, 0, 12))];
  assert.deepEqual(openMomentAfter(now, blocks, TZ), atLocal(11));
});

test("describeManualBlock: закрытый час — своя формулировка и замок до границы часа", () => {
  const now = atLocal(9, 30);
  const block = describeManualBlock(now, [hourBlock(9, atLocal(9, 0, 12))], TZ);
  assert.ok(block);
  assert.equal(block.type, "manual_block");
  assert.deepEqual(block.until, atLocal(10));
  assert.match(block.reason, /^9:00 — час закрыт вручную/);
  assert.match(block.reason, /откроется в 10:00/);
});

test("describeManualBlock: окно — формулировка расписания", () => {
  const now = atLocal(14, 10);
  const block = describeManualBlock(now, [windowBlock(atLocal(14), atLocal(18))], TZ);
  assert.ok(block);
  assert.match(block.reason, /^Торговля закрыта вручную по расписанию/);
  assert.match(block.reason, /откроется в 18:00/);
});

test("describeManualBlock: ничего не действует — null", () => {
  const now = atLocal(12);
  assert.equal(describeManualBlock(now, [], TZ), null);
});

test("formatOpenMoment: тот же локальный день — только время, минуты с нулём", () => {
  assert.equal(formatOpenMoment(atLocal(9, 30), atLocal(10, 5), TZ), "10:05");
});

test("formatOpenMoment: другой локальный день — с датой", () => {
  assert.equal(formatOpenMoment(atLocal(23, 30), atLocal(7, 0, 6), TZ), "6.10 в 7:00");
});

test("validateHourBlockInput: пределы часа и срока", () => {
  assert.equal(validateHourBlockInput({ hour: 9, days: 7 }, []), null);
  assert.match(validateHourBlockInput({ hour: 24, days: 7 }, []) ?? "", /от 0 до 23/);
  assert.match(validateHourBlockInput({ hour: 9.5, days: 7 }, []) ?? "", /от 0 до 23/);
  assert.match(validateHourBlockInput({ hour: 9, days: 0 }, []) ?? "", /Срок/);
  assert.match(validateHourBlockInput({ hour: 9, days: MAX_HOUR_BLOCK_DAYS + 1 }, []) ?? "", /Срок/);
});

test("validateHourBlockInput: уже закрытый час нельзя закрыть повторно", () => {
  assert.match(validateHourBlockInput({ hour: 9, days: 7 }, [9]) ?? "", /уже закрыт/);
});

test("buildWindow: собирает окно в таймзоне риск-плана", () => {
  const now = atLocal(12, 0, 1);
  const window = buildWindow({ date: "2026-10-05", from: "14:00", to: "18:00" }, now, TZ);
  assert.ok(!("error" in window));
  assert.deepEqual(window.startsAt, atLocal(14));
  assert.deepEqual(window.endsAt, atLocal(18));
});

test("buildWindow: конец 24:00 допустим — полночь следующего дня", () => {
  const now = atLocal(12, 0, 1);
  const window = buildWindow({ date: "2026-10-05", from: "22:00", to: "24:00" }, now, TZ);
  assert.ok(!("error" in window));
  assert.deepEqual(window.endsAt, atLocal(0, 0, 6));
});

test("buildWindow: «до» не позже «с» — ошибка", () => {
  const now = atLocal(12, 0, 1);
  assert.match(
    (buildWindow({ date: "2026-10-05", from: "18:00", to: "14:00" }, now, TZ) as { error: string }).error,
    /позже/,
  );
});

test("buildWindow: прошедшее окно — ошибка, уже идущее — допустимо", () => {
  const now = atLocal(15, 0, 5);
  assert.match(
    (buildWindow({ date: "2026-10-05", from: "10:00", to: "12:00" }, now, TZ) as { error: string }).error,
    /уже прошло/,
  );
  const running = buildWindow({ date: "2026-10-05", from: "14:00", to: "18:00" }, now, TZ);
  assert.ok(!("error" in running));
});

test("buildWindow: некорректные дата и время — ошибки", () => {
  const now = atLocal(12, 0, 1);
  assert.ok("error" in buildWindow({ date: "2026-02-31", from: "10:00", to: "12:00" }, now, TZ));
  assert.ok("error" in buildWindow({ date: "05.10.2026", from: "10:00", to: "12:00" }, now, TZ));
  assert.ok("error" in buildWindow({ date: "2026-10-05", from: "10:70", to: "12:00" }, now, TZ));
  assert.ok("error" in buildWindow({ date: "2026-10-05", from: "10:00", to: "25:00" }, now, TZ));
});

test("buildWindow: дальше года вперёд — ошибка", () => {
  const now = atLocal(12, 0, 1);
  assert.match(
    (buildWindow({ date: "2028-10-05", from: "10:00", to: "12:00" }, now, TZ) as { error: string }).error,
    /далёкая дата/,
  );
});

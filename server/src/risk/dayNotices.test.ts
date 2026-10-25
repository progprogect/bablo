import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDayNotices, type HourBlockForNotice } from "./dayNotices.js";

/** Таймзона и час сброса риск-плана по умолчанию — МСК (UTC+3), 07:00. */
const TZ = 180;
const RESET_HOUR = 7;

/** Момент «локальные часы:минуты» октябрьского дня 2026 года в реальном UTC. */
function atLocal(day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 9, day, hour, minute) - TZ * 60_000);
}

function notices(now: Date, hourBlocks: HourBlockForNotice[] = []) {
  return buildDayNotices({ now, resetHour: RESET_HOUR, tzOffsetMinutes: TZ, hourBlocks });
}

function ids(now: Date, hourBlocks: HourBlockForNotice[] = []): string[] {
  return notices(now, hourBlocks).map((notice) => notice.id);
}

test("день недели: в понедельник и пятницу предупреждение есть", () => {
  const monday = notices(atLocal(5, 12))[0];
  assert.equal(monday?.id, "weekday");
  assert.equal(monday?.title, "Сегодня понедельник");
  assert.equal(notices(atLocal(9, 12))[0]?.title, "Сегодня пятница");
});

test("день недели: в остальные дни предупреждения нет", () => {
  for (const day of [6, 7, 8, 10, 11]) {
    assert.deepEqual(ids(atLocal(day, 12)), [], `день ${day}`);
  }
});

test("день недели: ночь после пятницы — ещё пятница, день сбрасывается в 07:00", () => {
  assert.equal(notices(atLocal(10, 2))[0]?.title, "Сегодня пятница");
  assert.deepEqual(ids(atLocal(10, 8)), []);
});

test("час: в последний день блокировки — уведомление с датой открытия", () => {
  // Срок истекает 14.10 в 14:32, значит 14.10 в 9:00 час ещё закрыт — это последний раз.
  const notice = notices(atLocal(14, 10), [{ hour: 9, endsAt: atLocal(14, 14, 32) }])[0];
  assert.equal(notice?.id, "hour-open:9");
  assert.equal(notice?.title, "9:00 закрыт последний день");
  assert.match(notice?.detail ?? "", /^С 15\.10 торговать в 9:00 снова можно/);
});

test("час: в первый свободный день — уведомление, что час снова открыт", () => {
  const notice = notices(atLocal(15, 10), [{ hour: 9, endsAt: atLocal(14, 14, 32) }])[0];
  assert.equal(notice?.id, "hour-open:9");
  assert.equal(notice?.title, "9:00 снова открыт");
  assert.match(notice?.detail ?? "", /с сегодня, 15\.10/);
});

test("час: на следующий день после открытия уведомления уже нет", () => {
  // 13.10 — последний закрытый день, 14.10 — первый свободный, 15.10 — уже тишина
  // (все три дня не ПН и не ПТ, чтобы не мешалось предупреждение дня недели).
  assert.deepEqual(ids(atLocal(15, 10), [{ hour: 9, endsAt: atLocal(13, 14, 32) }]), []);
});

test("час: до последнего дня блокировки молчим", () => {
  assert.deepEqual(ids(atLocal(13, 10), [{ hour: 9, endsAt: atLocal(14, 14, 32) }]), []);
});

test("час: срок истёк раньше самого часа — последним был вчерашний", () => {
  // Срок истекает 14.10 в 14:32, час 16:00 в этот день уже свободен: последний закрытый
  // раз — 13.10, первый свободный день — 14.10.
  const block = [{ hour: 16, endsAt: atLocal(14, 14, 32) }];
  assert.equal(notices(atLocal(13, 10), block)[0]?.title, "16:00 закрыт последний день");
  assert.equal(notices(atLocal(14, 10), block)[0]?.title, "16:00 снова открыт");
});

test("час: ночь принадлежит вчерашнему торговому дню", () => {
  const block = [{ hour: 9, endsAt: atLocal(14, 14, 32) }];
  // 15.10 в 02:00 — ещё торговый день 14.10, то есть последний день блокировки.
  assert.equal(notices(atLocal(15, 2), block)[0]?.title, "9:00 закрыт последний день");
});

test("час закрыли заново — об открытии не сообщаем, срок задаёт последняя блокировка", () => {
  const blocks = [
    { hour: 9, endsAt: atLocal(14, 14, 32) },
    { hour: 9, endsAt: atLocal(21, 14, 32) },
  ];
  assert.deepEqual(ids(atLocal(15, 10), blocks), []);
  assert.equal(notices(atLocal(21, 10), blocks)[0]?.title, "9:00 закрыт последний день");
});

test("порядок: день недели первым, часы — по возрастанию", () => {
  const blocks = [
    { hour: 18, endsAt: atLocal(12, 14, 32) },
    { hour: 9, endsAt: atLocal(12, 14, 32) },
  ];
  assert.deepEqual(ids(atLocal(12, 10), blocks), ["weekday", "hour-open:9", "hour-open:18"]);
});

test("окна блокировки уведомлений не дают — только часы", () => {
  assert.deepEqual(ids(atLocal(7, 12)), []);
});

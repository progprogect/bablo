import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCooldownBlock, evaluateDailyLimitBlocks, pickEffectiveBlock } from "./limits.js";

const CONFIG = { cooldownMinutes: 60, dailyLossLimitR: -2, dailyProfitLimitR: 3, resetHour: 7, tzOffsetMinutes: 180 };

test("evaluateDailyLimitBlocks: сумма выше -2R и ниже +3R — блоков нет", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), -1, CONFIG);
  assert.deepEqual(blocks, []);
});

test("evaluateDailyLimitBlocks: сумма достигла -2R — блок до следующего сброса", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), -2, CONFIG);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "daily_loss");
});

test("evaluateDailyLimitBlocks: сумма превысила -2R (например -3R) — блок сохраняется", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), -3, CONFIG);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "daily_loss");
});

test("evaluateDailyLimitBlocks: сумма достигла +3R — блок до следующего сброса", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), 3, CONFIG);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "daily_profit");
});

test("evaluateCooldownBlock: нет предыдущей сделки — блока нет", () => {
  assert.equal(evaluateCooldownBlock(new Date(), null, 60), null);
});

test("evaluateCooldownBlock: сделка закрылась 10 минут назад — активен блок до +60 минут", () => {
  const closedAt = new Date("2026-07-13T10:00:00Z");
  const now = new Date("2026-07-13T10:10:00Z");
  const block = evaluateCooldownBlock(now, closedAt, 60);
  assert.ok(block);
  assert.equal(block?.until.toISOString(), "2026-07-13T11:00:00.000Z");
});

test("evaluateCooldownBlock: кулдаун истёк — блока нет", () => {
  const closedAt = new Date("2026-07-13T10:00:00Z");
  const now = new Date("2026-07-13T11:01:00Z");
  assert.equal(evaluateCooldownBlock(now, closedAt, 60), null);
});

test("pickEffectiveBlock: выбирает блокировку с самым поздним until", () => {
  const shortBlock = { type: "cooldown" as const, reason: "a", until: new Date("2026-07-13T11:00:00Z") };
  const longBlock = { type: "daily_loss" as const, reason: "b", until: new Date("2026-07-14T04:00:00Z") };
  const effective = pickEffectiveBlock([shortBlock, longBlock]);
  assert.equal(effective?.type, "daily_loss");
});

test("pickEffectiveBlock: пустой список — null", () => {
  assert.equal(pickEffectiveBlock([]), null);
});

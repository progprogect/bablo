import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVoluntaryPauseBlock,
  evaluateAssetSlBlocks,
  evaluateCooldownBlock,
  evaluateDailyLimitBlocks,
  isGlobalBlock,
  isStrongTakeProfit,
  isTpRatioAllowed,
  pickEffectiveBlock,
  type DailyLimitCounters,
} from "./limits.js";

const CONFIG = { cooldownMinutes: 60, dailyLossLimitR: -2, dailyProfitLimitR: 3, resetHour: 7, tzOffsetMinutes: 180 };

function counters(partial: Partial<DailyLimitCounters> = {}): DailyLimitCounters {
  return {
    sumR: 0,
    slCount: 0,
    tpCount: 0,
    strongTakeProfit: false,
    ...partial,
  };
}

test("evaluateDailyLimitBlocks: сумма выше -2R и ниже +3R, одна закрытая сделка — блоков нет", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ sumR: -1, slCount: 1 }), CONFIG);
  assert.deepEqual(blocks, []);
});

test("evaluateDailyLimitBlocks: сумма 2.85R — выше порога с допуском (3 - 0.2 = 2.8R), daily_profit срабатывает", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ sumR: 2.85 }), CONFIG);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "daily_profit");
});

test("evaluateDailyLimitBlocks: сумма 2.7R — ниже порога с допуском, блока нет", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ sumR: 2.7 }), CONFIG);
  assert.deepEqual(blocks, []);
});

test("evaluateDailyLimitBlocks: сумма достигла -2R — блок до следующего сброса", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ sumR: -2, slCount: 1 }), CONFIG);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "daily_loss");
});

test("evaluateDailyLimitBlocks: сумма превысила -2R (например -3R) — блок сохраняется", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ sumR: -3, slCount: 1 }), CONFIG);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "daily_loss");
});

test("evaluateDailyLimitBlocks: сумма достигла +3R — блок до следующего сброса", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ sumR: 3 }), CONFIG);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "daily_profit");
});

test("evaluateDailyLimitBlocks: 2 сделки за день закрыты по стопу — блок независимо от суммы R", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ sumR: 0.5, slCount: 2 }), CONFIG);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "daily_stop_losses");
});

test("evaluateDailyLimitBlocks: текст блока по стопам — факт без упоминания серии", () => {
  const two = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ slCount: 2 }), CONFIG);
  assert.match(two[0]?.reason ?? "", /^2 сделки за день закрыты по стопу\. Дадим себе и графику/);

  // Сниженный лимит (внутри серии хватает одного стопа) текст не меняет: про серию
  // говорит отдельный лок stop_chain, и только когда она закрывает дни сверх сегодняшнего.
  const one = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ slCount: 1 }), CONFIG, 1);
  assert.equal(one[0]?.type, "daily_stop_losses");
  assert.match(one[0]?.reason ?? "", /^Сделка дня закрыта по стопу\. Дадим себе и графику/);
  assert.doesNotMatch(one[0]?.reason ?? "", /сери/i);
});

test("evaluateDailyLimitBlocks: 1 сделка по стопу — блока по этому правилу нет", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ sumR: 0.5, slCount: 1 }), CONFIG);
  assert.deepEqual(blocks, []);
});

test("evaluateDailyLimitBlocks: 2 тейка за день — блок даже если сумма < +3R", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ sumR: 2, tpCount: 2 }), CONFIG);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "daily_take_profits");
});

test("evaluateDailyLimitBlocks: 1 тейк — блока по числу тейков нет", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ sumR: 2, tpCount: 1 }), CONFIG);
  assert.deepEqual(blocks, []);
});

test("evaluateDailyLimitBlocks: первая сделка дня — тейк 2R, блок независимо от суммы R", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-07-13T10:00:00Z"),
    counters({ sumR: 2, tpCount: 1, strongTakeProfit: true }),
    CONFIG,
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "daily_strong_tp");
});

test("evaluateDailyLimitBlocks: за день есть и тейк, и стоп — блок в любом порядке", () => {
  // Тейк 1R потом стоп (итог 0R) и стоп потом тейк дают одни и те же счётчики —
  // правило #15 смотрит на факт «был и тейк, и стоп», порядок ему не нужен.
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-07-13T10:00:00Z"),
    counters({ sumR: 0, slCount: 1, tpCount: 1 }),
    CONFIG,
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "daily_mixed_outcomes");
});

test("evaluateDailyLimitBlocks: стоп, потом тейк 2R — срабатывают оба правила, показывается тейк", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-07-13T10:00:00Z"),
    counters({ sumR: 1, slCount: 1, tpCount: 1, strongTakeProfit: true }),
    CONFIG,
  );
  assert.deepEqual(blocks.map((b) => b.type), ["daily_strong_tp", "daily_mixed_outcomes"]);
  // Все дневные блоки заканчиваются одним сбросом — при равных until берётся первый.
  assert.equal(pickEffectiveBlock(blocks)?.type, "daily_strong_tp");
});

test("evaluateDailyLimitBlocks: один тейк меньше 2R — день продолжается", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-07-13T10:00:00Z"),
    counters({ sumR: 1, tpCount: 1 }),
    CONFIG,
  );
  assert.deepEqual(blocks, []);
});

test("evaluateDailyLimitBlocks: несколько условий одновременно — несколько блоков", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-07-13T10:00:00Z"),
    counters({ sumR: -2, slCount: 2, tpCount: 2 }),
    CONFIG,
  );
  assert.equal(blocks.length, 4);
  assert.deepEqual(
    blocks.map((b) => b.type).sort(),
    ["daily_loss", "daily_mixed_outcomes", "daily_stop_losses", "daily_take_profits"],
  );
});

test("isStrongTakeProfit: 1.85R проходит допуск 0.2, 1.7R — нет", () => {
  assert.equal(isStrongTakeProfit(1.85), true);
  assert.equal(isStrongTakeProfit(2), true);
  assert.equal(isStrongTakeProfit(1.7), false);
});

test("evaluateCooldownBlock: нет предыдущей сделки — блока нет", () => {
  assert.equal(evaluateCooldownBlock(new Date(), null, 60, null), null);
});

test("evaluateCooldownBlock: после стопа 10 минут назад — активен блок до +60 минут", () => {
  const closedAt = new Date("2026-07-13T10:00:00Z");
  const now = new Date("2026-07-13T10:10:00Z");
  const block = evaluateCooldownBlock(now, closedAt, 60, "sl");
  assert.ok(block);
  assert.equal(block?.until.toISOString(), "2026-07-13T11:00:00.000Z");
});

test("evaluateCooldownBlock: после ТЕЙКА паузы нет", () => {
  const closedAt = new Date("2026-07-13T10:00:00Z");
  const now = new Date("2026-07-13T10:10:00Z");
  assert.equal(evaluateCooldownBlock(now, closedAt, 60, "tp"), null);
});

test("evaluateCooldownBlock: безубыток и ручное закрытие паузу оставляют", () => {
  const closedAt = new Date("2026-07-13T10:00:00Z");
  const now = new Date("2026-07-13T10:10:00Z");
  assert.ok(evaluateCooldownBlock(now, closedAt, 60, "be"));
  assert.ok(evaluateCooldownBlock(now, closedAt, 60, "other"));
  // Исход неизвестен (данных нет) — ведём себя как раньше, с паузой.
  assert.ok(evaluateCooldownBlock(now, closedAt, 60, null));
});

test("evaluateCooldownBlock: кулдаун истёк — блока нет", () => {
  const closedAt = new Date("2026-07-13T10:00:00Z");
  const now = new Date("2026-07-13T11:01:00Z");
  assert.equal(evaluateCooldownBlock(now, closedAt, 60, "sl"), null);
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

test("pickEffectiveBlock: игнорирует asset_sl_today — день целиком не закрывает", () => {
  const assetOnly = {
    type: "asset_sl_today" as const,
    reason: "По TIA уже был стоп сегодня — повторный вход завтра",
    until: new Date("2026-07-14T04:00:00Z"),
    symbol: "TIA-USDT",
  };
  assert.equal(pickEffectiveBlock([assetOnly]), null);

  const withGlobal = {
    type: "cooldown" as const,
    reason: "a",
    until: new Date("2026-07-13T11:00:00Z"),
  };
  assert.equal(pickEffectiveBlock([assetOnly, withGlobal])?.type, "cooldown");
});

test("evaluateAssetSlBlocks: пустой список — блоков нет", () => {
  assert.deepEqual(evaluateAssetSlBlocks(new Date("2026-07-13T10:00:00Z"), [], CONFIG), []);
});

test("evaluateAssetSlBlocks: уникальные символы со стопом — по блоку на каждый до сброса дня", () => {
  const blocks = evaluateAssetSlBlocks(
    new Date("2026-07-13T10:00:00Z"),
    ["TIA-USDT", "TAO-USDT", "TIA-USDT"],
    CONFIG,
  );
  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks.map((b) => b.symbol).sort(),
    ["TAO-USDT", "TIA-USDT"],
  );
  assert.ok(blocks.every((b) => b.type === "asset_sl_today"));
  assert.ok(blocks.every((b) => b.until.toISOString() === "2026-07-14T04:00:00.000Z"));
  assert.equal(blocks.find((b) => b.symbol === "TIA-USDT")?.reason.includes("TIA"), true);
});

test("isGlobalBlock: asset_sl_today — false, остальные — true", () => {
  assert.equal(isGlobalBlock({ type: "asset_sl_today" }), false);
  assert.equal(isGlobalBlock({ type: "cooldown" }), true);
  assert.equal(isGlobalBlock({ type: "daily_stop_losses" }), true);
});

// Правило #11 (15.09.2026): после стопа цель не дальше 1/2.
test("isTpRatioAllowed: после стопа цель дальше 1/2 запрещена", () => {
  assert.equal(isTpRatioAllowed(3, true), false);
  assert.equal(isTpRatioAllowed(2.5, true), false);
  assert.equal(isTpRatioAllowed(2, true), true);
  assert.equal(isTpRatioAllowed(1.5, true), true);
  // Выравнивающий пресет 1/1.9 (TP на 1.9×R₀) под ограничение не попадает.
  assert.equal(isTpRatioAllowed(1.9, true), true);
});

test("isTpRatioAllowed: допуск на округление цены — 2.01R это всё ещё 1/2", () => {
  assert.equal(isTpRatioAllowed(2.01, true), true);
  assert.equal(isTpRatioAllowed(2.05, true), true);
  assert.equal(isTpRatioAllowed(2.06, true), false);
});

test("isTpRatioAllowed: предыдущая сделка не стоп — ограничений нет", () => {
  assert.equal(isTpRatioAllowed(3, false), true);
  assert.equal(isTpRatioAllowed(10, false), true);
});

test("isTpRatioAllowed: R/R посчитать не удалось — не блокируем", () => {
  assert.equal(isTpRatioAllowed(null, true), true);
});

// Правило #13: добровольная пауза «поберечь депозит» закрывает входы на два часа.
test("buildVoluntaryPauseBlock: пауза 2 часа с понятной причиной", () => {
  const now = new Date("2026-09-18T10:00:00.000Z");
  const block = buildVoluntaryPauseBlock(now);
  assert.equal(block.type, "voluntary_pause");
  assert.equal(block.until.toISOString(), "2026-09-18T12:00:00.000Z");
  assert.match(block.reason, /пауза 2 часа/);
  // Глобальная блокировка — скрывает форму открытия целиком.
  assert.equal(isGlobalBlock(block), true);
});

test("buildVoluntaryPauseBlock: при нескольких глобальных локах действует самый долгий", () => {
  const now = new Date("2026-09-18T10:00:00.000Z");
  const cooldown = evaluateCooldownBlock(now, new Date("2026-09-18T09:30:00.000Z"), 60, "sl");
  const effective = pickEffectiveBlock([cooldown!, buildVoluntaryPauseBlock(now)]);
  assert.equal(effective?.type, "voluntary_pause");
});

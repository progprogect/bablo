import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDayOffBlock,
  buildVoluntaryPauseBlock,
  dayStopLimitForDayKey,
  dayTakeLimitForDayKey,
  evaluateAssetSlBlocks,
  evaluateCooldownBlock,
  evaluateDailyLimitBlocks,
  evaluateFirstTradeStrongTpBlock,
  evaluateSundayFirstStopBlock,
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
    ...partial,
  };
}

test("evaluateDailyLimitBlocks: сумма выше -2R, одна закрытая сделка — блоков нет", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ sumR: -1, slCount: 1 }), CONFIG);
  assert.deepEqual(blocks, []);
});

// Правило #3 (+3R за день) отменено 25.10.2026: прибыль день не закрывает.
test("evaluateDailyLimitBlocks: прибыль за день блока не даёт, сколько бы её ни было", () => {
  const now = new Date("2026-07-13T10:00:00Z");
  for (const sumR of [2.85, 3, 5, 12]) {
    assert.deepEqual(
      evaluateDailyLimitBlocks(now, counters({ sumR, tpCount: 3 }), CONFIG),
      [],
      `${sumR}R`,
    );
  }
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

test("evaluateDailyLimitBlocks: 2 сделки за день закрыты по стопу — блок независимо от суммы R", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ sumR: 0.5, slCount: 2 }), CONFIG);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "daily_stop_losses");
});

test("evaluateDailyLimitBlocks: текст блока по стопам — коротко и без упоминания серии", () => {
  const two = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ slCount: 2 }), CONFIG);
  assert.equal(two[0]?.reason, "2 стопа за день — дадим себе и графику расторговаться");
  assert.doesNotMatch(two[0]?.reason ?? "", /сери/i);
});

test("evaluateDailyLimitBlocks: причины помещаются в плашку — не длиннее 60 символов", () => {
  // Под причиной на дашборде идёт крупный таймер: длинный текст уезжает на 3–4 строки
  // и плашка перестаёт читаться (замечание пользователя 02.10.2026).
  const all = [
    ...evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ sumR: -2, slCount: 2 }), CONFIG),
    ...evaluateDailyLimitBlocks(
      new Date("2026-07-13T10:00:00Z"),
      counters({ sumR: 1, tpCount: 1, slCount: 1 }),
      CONFIG,
    ),
  ];
  assert.ok(all.length >= 3, "проверяем все дневные причины разом");
  for (const block of all) {
    assert.ok(block.reason.length <= 60, `${block.type}: ${block.reason.length} символов — ${block.reason}`);
  }
});

test("evaluateDailyLimitBlocks: 1 сделка по стопу — блока по этому правилу нет", () => {
  const blocks = evaluateDailyLimitBlocks(new Date("2026-07-13T10:00:00Z"), counters({ sumR: 0.5, slCount: 1 }), CONFIG);
  assert.deepEqual(blocks, []);
});

// Правила #5 (два тейка) и #6 (тейк ≥ 2R) отменены 25.10.2026: пока идут тейки,
// торговать можно дальше — день заканчивает стоп, а не прибыль.
test("evaluateDailyLimitBlocks: тейки день не закрывают — ни числом, ни размером", () => {
  const now = new Date("2026-07-13T10:00:00Z");
  assert.deepEqual(evaluateDailyLimitBlocks(now, counters({ sumR: 2, tpCount: 1 }), CONFIG), []);
  assert.deepEqual(evaluateDailyLimitBlocks(now, counters({ sumR: 2, tpCount: 2 }), CONFIG), []);
  assert.deepEqual(evaluateDailyLimitBlocks(now, counters({ sumR: 6, tpCount: 4 }), CONFIG), []);
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

test("evaluateDailyLimitBlocks: стоп, потом тейк 2R — день закрыт смешанным исходом", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-07-13T10:00:00Z"),
    counters({ sumR: 1, slCount: 1, tpCount: 1 }),
    CONFIG,
  );
  assert.deepEqual(blocks.map((b) => b.type), ["daily_mixed_outcomes"]);
  assert.equal(pickEffectiveBlock(blocks)?.type, "daily_mixed_outcomes");
});

test("evaluateDailyLimitBlocks: один тейк — день продолжается", () => {
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
  assert.equal(blocks.length, 3);
  assert.deepEqual(
    blocks.map((b) => b.type).sort(),
    ["daily_loss", "daily_mixed_outcomes", "daily_stop_losses"],
  );
});

// Признак «полного тейка» на блокировки больше не влияет — остался историей в daily_stats.
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

// --- Правило #16 (10.10.2026, расширено 25.10.2026): в ПН и ПТ день закрывает
// одна закрытая сделка — хоть стоп, хоть тейк ---

test("dayStopLimitForDayKey: ПН, ПТ и СБ — один стоп, остальные дни — два", () => {
  // 2026-10-12 — понедельник, 2026-10-16 — пятница, 2026-10-17 — суббота.
  assert.equal(dayStopLimitForDayKey("2026-10-12"), 1);
  assert.equal(dayStopLimitForDayKey("2026-10-16"), 1);
  assert.equal(dayStopLimitForDayKey("2026-10-17"), 1);
  assert.equal(dayStopLimitForDayKey("2026-10-13"), 2); // вторник
  assert.equal(dayStopLimitForDayKey("2026-10-15"), 2); // четверг
  assert.equal(dayStopLimitForDayKey("2026-10-18"), 2); // воскресенье
});

test("dayStopLimitForDayKey: битый ключ дня не меняет лимит", () => {
  assert.equal(dayStopLimitForDayKey("не дата"), 2);
});

test("evaluateDailyLimitBlocks: один стоп в понедельник закрывает день", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-10-12T10:00:00Z"),
    counters({ sumR: -1, slCount: 1 }),
    CONFIG,
    "2026-10-12",
  );
  const stopBlock = blocks.find((block) => block.type === "daily_stop_losses");
  assert.ok(stopBlock);
  assert.equal(stopBlock.reason, "Стоп в понедельник — на сегодня всё");
});

test("evaluateDailyLimitBlocks: один стоп в пятницу закрывает день", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-10-16T10:00:00Z"),
    counters({ sumR: -1, slCount: 1 }),
    CONFIG,
    "2026-10-16",
  );
  const stopBlock = blocks.find((block) => block.type === "daily_stop_losses");
  assert.ok(stopBlock);
  assert.match(stopBlock.reason, /Стоп в пятницу/);
});

test("evaluateDailyLimitBlocks: один стоп во вторник день не закрывает", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-10-13T10:00:00Z"),
    counters({ sumR: -1, slCount: 1 }),
    CONFIG,
    "2026-10-13",
  );
  assert.equal(blocks.some((block) => block.type === "daily_stop_losses"), false);
});

// --- Правило #17 (06.11.2026): в субботу день закрывает один стоп, тейки — нет ---

test("evaluateDailyLimitBlocks: один стоп в субботу закрывает день", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-10-17T10:00:00Z"),
    counters({ sumR: -1, slCount: 1 }),
    CONFIG,
    "2026-10-17",
  );
  const stopBlock = blocks.find((block) => block.type === "daily_stop_losses");
  assert.ok(stopBlock);
  assert.equal(stopBlock.reason, "Стоп в субботу — на сегодня всё");
});

test("evaluateDailyLimitBlocks: тейк в субботу день не закрывает", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-10-17T10:00:00Z"),
    counters({ sumR: 2, tpCount: 1 }),
    CONFIG,
    "2026-10-17",
  );
  assert.deepEqual(blocks, []);
});

test("evaluateDailyLimitBlocks: тейк и стоп в субботу закрывают день смешанным раскладом", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-10-17T10:00:00Z"),
    counters({ sumR: 1, slCount: 1, tpCount: 1 }),
    CONFIG,
    "2026-10-17",
  );
  assert.ok(blocks.some((block) => block.type === "daily_mixed_outcomes"));
  assert.equal(blocks.some((block) => block.type === "daily_take_profits"), false);
});

test("evaluateDailyLimitBlocks: два стопа в понедельник — обычный текст, не про день недели", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-10-12T10:00:00Z"),
    counters({ slCount: 2 }),
    CONFIG,
    "2026-10-12",
  );
  const stopBlock = blocks.find((block) => block.type === "daily_stop_losses");
  assert.ok(stopBlock);
  assert.match(stopBlock.reason, /2 стопа за день/);
});

test("evaluateDailyLimitBlocks: причина про день недели помещается в плашку", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-10-12T10:00:00Z"),
    counters({ slCount: 1 }),
    CONFIG,
    "2026-10-12",
  );
  for (const block of blocks) {
    assert.ok(block.reason.length <= 60, `${block.reason} (${block.reason.length})`);
  }
});

test("dayTakeLimitForDayKey: лимит тейков есть только в ПН и ПТ", () => {
  assert.equal(dayTakeLimitForDayKey("2026-10-12"), 1); // понедельник
  assert.equal(dayTakeLimitForDayKey("2026-10-16"), 1); // пятница
  assert.equal(dayTakeLimitForDayKey("2026-10-13"), null); // вторник
  assert.equal(dayTakeLimitForDayKey("2026-10-18"), null); // воскресенье
  // Суббота (правило #17) ужесточает только стопы — тейки день не закрывают.
  assert.equal(dayTakeLimitForDayKey("2026-10-17"), null);
  assert.equal(dayTakeLimitForDayKey("не дата"), null);
});

test("evaluateDailyLimitBlocks: один тейк в понедельник закрывает день", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-10-12T10:00:00Z"),
    counters({ sumR: 1, tpCount: 1 }),
    CONFIG,
    "2026-10-12",
  );
  const takeBlock = blocks.find((block) => block.type === "daily_take_profits");
  assert.ok(takeBlock);
  assert.equal(takeBlock.reason, "Тейк в понедельник — на сегодня достаточно");
  // Именно эта причина и покажется на дашборде: блоки дня истекают одновременно,
  // а pickEffectiveBlock при равенстве оставляет первый.
  assert.equal(pickEffectiveBlock(blocks)?.type, "daily_take_profits");
});

test("evaluateDailyLimitBlocks: тейк в пятницу закрывает день при любом R", () => {
  // Слабый тейк 0.9R: в обычный день он день не закрывает, в пятницу — закрывает.
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-10-16T10:00:00Z"),
    counters({ sumR: 0.9, tpCount: 1 }),
    CONFIG,
    "2026-10-16",
  );
  const takeBlock = blocks.find((block) => block.type === "daily_take_profits");
  assert.ok(takeBlock);
  assert.match(takeBlock.reason, /Тейк в пятницу/);
});

test("evaluateDailyLimitBlocks: один тейк во вторник день не закрывает", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-10-13T10:00:00Z"),
    counters({ sumR: 1, tpCount: 1 }),
    CONFIG,
    "2026-10-13",
  );
  assert.equal(blocks.some((block) => block.type === "daily_take_profits"), false);
});

test("evaluateDailyLimitBlocks: второй тейк в понедельник ничего не меняет — день уже закрыт", () => {
  // Второго тейка в ПН быть не должно, но исход можно переразметить в админке —
  // причина остаётся той же, про день недели.
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-10-12T10:00:00Z"),
    counters({ sumR: 2, tpCount: 2 }),
    CONFIG,
    "2026-10-12",
  );
  const takeBlock = blocks.find((block) => block.type === "daily_take_profits");
  assert.ok(takeBlock);
  assert.equal(takeBlock.reason, "Тейк в понедельник — на сегодня достаточно");
});

test("evaluateDailyLimitBlocks: без ключа дня правило дня недели не действует", () => {
  // Дата та же (понедельник), но ключ не передан: старые вызовы работают как раньше.
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-10-12T10:00:00Z"),
    counters({ sumR: 1, tpCount: 1 }),
    CONFIG,
  );
  assert.deepEqual(blocks, []);
});

test("evaluateDailyLimitBlocks: причина про тейк в ПН/ПТ помещается в плашку", () => {
  const blocks = evaluateDailyLimitBlocks(
    new Date("2026-10-12T10:00:00Z"),
    counters({ sumR: 1, tpCount: 1 }),
    CONFIG,
    "2026-10-12",
  );
  for (const block of blocks) {
    assert.ok(block.reason.length <= 60, `${block.reason} (${block.reason.length})`);
  }
});

// --- Правило #19 (06.11.2026): пятница — выходной, торговля закрыта весь день ---

test("buildDayOffBlock: пятница закрыта до сброса следующего дня", () => {
  // 2026-10-09 — пятница; 12:00 МСК = 09:00 UTC, сброс в 07:00 МСК = 04:00 UTC субботы.
  const block = buildDayOffBlock(new Date("2026-10-09T09:00:00Z"), "2026-10-09", CONFIG);
  assert.ok(block);
  assert.equal(block.type, "weekday_day_off");
  assert.equal(block.reason, "Пятница — выходной. Сегодня можно отдохнуть");
  assert.deepEqual(block.until, new Date("2026-10-10T04:00:00Z"));
  assert.ok(block.reason.length <= 60);
});

test("buildDayOffBlock: ночь с пятницы на субботу — ещё выходной", () => {
  // 02:00 МСК субботы — торговый день ещё пятничный, ключ дня это и говорит.
  const block = buildDayOffBlock(new Date("2026-10-09T23:00:00Z"), "2026-10-09", CONFIG);
  assert.ok(block);
  assert.deepEqual(block.until, new Date("2026-10-10T04:00:00Z"));
});

test("buildDayOffBlock: рабочие дни и битый ключ — null", () => {
  assert.equal(buildDayOffBlock(new Date("2026-10-12T09:00:00Z"), "2026-10-12", CONFIG), null);
  assert.equal(buildDayOffBlock(new Date("2026-10-17T09:00:00Z"), "2026-10-17", CONFIG), null);
  assert.equal(buildDayOffBlock(new Date("2026-10-09T09:00:00Z"), "не дата", CONFIG), null);
});

// --- Правило #22 (18.11.2026): первая сделка дня — тейк ≥ 2R → день закрыт ---

test("правило #22: тейк 2R первой сделкой закрывает день до сброса", () => {
  const block = evaluateFirstTradeStrongTpBlock(
    new Date("2026-11-18T09:00:00Z"),
    { outcome: "tp", resultR: 2.1 },
    CONFIG,
  );
  assert.ok(block);
  assert.equal(block.type, "first_strong_tp");
  assert.equal(block.reason, "Тейк 2R первой сделкой — на сегодня достаточно");
  // Сброс дня — 07:00 МСК следующего дня (04:00 UTC): «до следующего дня», без выходного.
  assert.deepEqual(block.until, new Date("2026-11-19T04:00:00Z"));
  assert.ok(block.reason.length <= 60);
});

test("правило #22: допуск как у статистики — 1.85R это тоже полный тейк", () => {
  const block = evaluateFirstTradeStrongTpBlock(
    new Date("2026-11-18T09:00:00Z"),
    { outcome: "tp", resultR: 1.85 },
    CONFIG,
  );
  assert.ok(block);
});

test("правило #22: обычный тейк, стоп или отсутствие сделок день не закрывают", () => {
  const now = new Date("2026-11-18T09:00:00Z");
  assert.equal(evaluateFirstTradeStrongTpBlock(now, { outcome: "tp", resultR: 1 }, CONFIG), null);
  assert.equal(evaluateFirstTradeStrongTpBlock(now, { outcome: "sl", resultR: -1 }, CONFIG), null);
  // Исход не «tp» (безубыток с плюсом) — не считается, даже при большом R.
  assert.equal(evaluateFirstTradeStrongTpBlock(now, { outcome: "be", resultR: 2.5 }, CONFIG), null);
  assert.equal(evaluateFirstTradeStrongTpBlock(now, null, CONFIG), null);
});

// --- Правило #23 (22.11.2026): стоп первой сделкой в воскресенье → день закрыт ---

test("правило #23: стоп первой сделкой в воскресенье закрывает день до сброса", () => {
  // 2026-11-29 — воскресенье (уже после отсечки включения); 12:00 МСК = 09:00 UTC.
  const block = evaluateSundayFirstStopBlock(
    new Date("2026-11-29T09:00:00Z"),
    { outcome: "sl" },
    CONFIG,
    "2026-11-29",
  );
  assert.ok(block);
  assert.equal(block.type, "sunday_first_stop");
  assert.equal(block.reason, "Стоп первой сделкой в воскресенье — день закрыт");
  // «На день»: до сброса 07:00 МСК понедельника (04:00 UTC), без дополнительного выходного.
  assert.deepEqual(block.until, new Date("2026-11-30T04:00:00Z"));
  assert.ok(block.reason.length <= 60);
});

test("правило #23: тейк/БУ первой сделкой или отсутствие сделок день не закрывают", () => {
  const now = new Date("2026-11-29T09:00:00Z");
  assert.equal(evaluateSundayFirstStopBlock(now, { outcome: "tp" }, CONFIG, "2026-11-29"), null);
  assert.equal(evaluateSundayFirstStopBlock(now, { outcome: "be" }, CONFIG, "2026-11-29"), null);
  assert.equal(evaluateSundayFirstStopBlock(now, { outcome: "other" }, CONFIG, "2026-11-29"), null);
  assert.equal(evaluateSundayFirstStopBlock(now, null, CONFIG, "2026-11-29"), null);
});

test("правило #23: действует только в воскресенье", () => {
  // 2026-11-28 — суббота: там день закрывает любой стоп (правило #17), но не это правило.
  assert.equal(
    evaluateSundayFirstStopBlock(
      new Date("2026-11-28T09:00:00Z"),
      { outcome: "sl" },
      CONFIG,
      "2026-11-28",
    ),
    null,
  );
});

test("правило #23: не задним числом — воскресенье до даты включения не считается", () => {
  // 22.11.2026 — воскресенье самого выката: стоп, сделанный до появления правила, не
  // должен закрыть остаток дня (та же логика, что отсечка правил #20/#21).
  assert.equal(
    evaluateSundayFirstStopBlock(
      new Date("2026-11-22T09:00:00Z"),
      { outcome: "sl" },
      CONFIG,
      "2026-11-22",
    ),
    null,
  );
});

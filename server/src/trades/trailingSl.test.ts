import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTrailingSlMove, trailingLadderFor } from "./trailingSl.js";

// Базовая сделка: лонг, вход 100, исходный стоп 95, риск 50$ на 10 монет → 1R = 5.
// Отсюда цены уровней: 1.9R = 109.5, 2.25R = 111.25, 2.8R = 114, 3R = 115, 3.5R = 117.5.
const base = {
  rrPreset: "1/3" as string | null,
  side: "long" as const,
  entryPrice: 100,
  currentSlPrice: 95,
  riskUsd: 50,
  quantity: 10,
  partialTpPrice: null as number | null,
  appliedTriggerR: null as number | null,
};

test("trailingLadderFor: лестница только у 1/3 и 1/4", () => {
  assert.ok(trailingLadderFor("1/3"));
  assert.ok(trailingLadderFor("1/4"));
  assert.equal(trailingLadderFor("1/2"), null);
  assert.equal(trailingLadderFor("1/5"), null);
  assert.equal(trailingLadderFor(null), null);
});

test("1/3: до 1.9R — ничего, на 1.9R — стоп на вход, на 2.25R — стоп на +1R", () => {
  assert.equal(decideTrailingSlMove({ ...base, price: 109.4 }).action, "skip");

  const atFirst = decideTrailingSlMove({ ...base, price: 109.5 });
  assert.deepEqual(atFirst, { action: "move", triggerR: 1.9, slR: 0, newSlPrice: 100 });

  const atSecond = decideTrailingSlMove({
    ...base,
    appliedTriggerR: 1.9,
    currentSlPrice: 100,
    price: 111.25,
  });
  assert.deepEqual(atSecond, { action: "move", triggerR: 2.25, slR: 1, newSlPrice: 105 });

  // Вся лестница 1/3 пройдена — дальше только сам тейк 3R.
  assert.equal(
    decideTrailingSlMove({ ...base, appliedTriggerR: 2.25, currentSlPrice: 105, price: 114 }).action,
    "skip",
  );
});

test("1/4: лестница 1.9→вход, 2.25→1R, 2.8→1.5R, 3→2R, 3.5→2.5R", () => {
  const ladder = [
    { price: 109.5, triggerR: 1.9, slR: 0, newSlPrice: 100 },
    { price: 111.25, triggerR: 2.25, slR: 1, newSlPrice: 105 },
    { price: 114, triggerR: 2.8, slR: 1.5, newSlPrice: 107.5 },
    { price: 115, triggerR: 3, slR: 2, newSlPrice: 110 },
    { price: 117.5, triggerR: 3.5, slR: 2.5, newSlPrice: 112.5 },
  ];
  let applied: number | null = null;
  let sl: number | null = 95;
  for (const step of ladder) {
    const decision = decideTrailingSlMove({
      ...base,
      rrPreset: "1/4",
      appliedTriggerR: applied,
      currentSlPrice: sl,
      price: step.price,
    });
    assert.equal(decision.action, "move");
    if (decision.action === "move") {
      assert.equal(decision.triggerR, step.triggerR);
      assert.equal(decision.slR, step.slR);
      assert.equal(decision.newSlPrice, step.newSlPrice);
      applied = decision.triggerR;
      sl = decision.newSlPrice;
    }
  }
});

test("пороги срабатывают раньше круглых уровней (правка 08.09.2026)", () => {
  // Цена развернулась на 2.9R, не дотянув до 3R: по старой лестнице ступень «3R → +2R»
  // не сработала бы, по новой — стоп уже уехал на +1.5R (порог 2.8R).
  const decision = decideTrailingSlMove({
    ...base,
    rrPreset: "1/4",
    appliedTriggerR: 2.25,
    currentSlPrice: 105,
    price: 114.5, // 2.9R
  });
  assert.deepEqual(decision, { action: "move", triggerR: 2.8, slR: 1.5, newSlPrice: 107.5 });
});

test("резкий ход через несколько ступеней — сразу верхний достигнутый уровень", () => {
  const decision = decideTrailingSlMove({ ...base, rrPreset: "1/4", price: 116 }); // 3.2R
  assert.deepEqual(decision, { action: "move", triggerR: 3, slR: 2, newSlPrice: 110 });
});

test("шорт: уровни зеркальны", () => {
  const decision = decideTrailingSlMove({
    ...base,
    side: "short",
    currentSlPrice: 105,
    price: 90.5, // 1.9R вниз
  });
  assert.deepEqual(decision, { action: "move", triggerR: 1.9, slR: 0, newSlPrice: 100 });
});

test("частичная фиксация задана — лестница не применяется", () => {
  const decision = decideTrailingSlMove({ ...base, partialTpPrice: 108, price: 115 });
  assert.equal(decision.action, "skip");
});

test("стоп уже не хуже целевого (ночное правило опередило) — settle без движения", () => {
  // SL уже на +1R (105), цена дошла до 1.9R: целевой стоп — вход (100), хуже текущего.
  const decision = decideTrailingSlMove({ ...base, currentSlPrice: 105, price: 109.5 });
  assert.deepEqual(decision, { action: "settle", triggerR: 1.9 });

  // А на 2.8R (1/4) целевой +1.5R (107.5) уже лучше 105 — двигаем.
  const further = decideTrailingSlMove({
    ...base,
    rrPreset: "1/4",
    currentSlPrice: 105,
    appliedTriggerR: 2.25,
    price: 114,
  });
  assert.deepEqual(further, { action: "move", triggerR: 2.8, slR: 1.5, newSlPrice: 107.5 });
});

test("прогресс со старой лестницы не ломает переход (2 и 2.5 в БД)", () => {
  // Активные сделки могли сохранить пороги прежней лестницы: 2 (стоп на входе) и
  // 2.5 (стоп на +1R). Сравнение идёт по «строго больше», поэтому пройденные ступени
  // не повторяются, а следующие срабатывают как надо.
  const afterOldTwo = decideTrailingSlMove({
    ...base,
    rrPreset: "1/4",
    appliedTriggerR: 2,
    currentSlPrice: 100,
    price: 111.25, // 2.25R
  });
  assert.deepEqual(afterOldTwo, { action: "move", triggerR: 2.25, slR: 1, newSlPrice: 105 });

  const afterOldTwoHalf = decideTrailingSlMove({
    ...base,
    rrPreset: "1/4",
    appliedTriggerR: 2.5,
    currentSlPrice: 105,
    price: 114, // 2.8R
  });
  assert.deepEqual(afterOldTwoHalf, { action: "move", triggerR: 2.8, slR: 1.5, newSlPrice: 107.5 });
});

test("уровни считаются от исходного риска, а не от текущего стопа", () => {
  // Стоп уже подтянут на 99, но 1R остаётся 5 (riskUsd/quantity): 1.9R — это 109.5.
  assert.equal(decideTrailingSlMove({ ...base, currentSlPrice: 99, price: 108 }).action, "skip");
  assert.equal(decideTrailingSlMove({ ...base, currentSlPrice: 99, price: 109.5 }).action, "move");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTrailingSlMove, trailingLadderFor } from "./trailingSl.js";

// Базовая сделка: лонг, вход 100, исходный стоп 95, риск 50$ на 10 монет → 1R = 5.
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

test("1/3: до 2R — ничего, на 2R — стоп на вход, на 2.5R — стоп на +1R", () => {
  assert.equal(decideTrailingSlMove({ ...base, price: 109.9 }).action, "skip");

  const atTwo = decideTrailingSlMove({ ...base, price: 110 });
  assert.deepEqual(atTwo, { action: "move", triggerR: 2, slR: 0, newSlPrice: 100 });

  const atTwoHalf = decideTrailingSlMove({ ...base, appliedTriggerR: 2, currentSlPrice: 100, price: 112.5 });
  assert.deepEqual(atTwoHalf, { action: "move", triggerR: 2.5, slR: 1, newSlPrice: 105 });

  // Всё применено — выше уровней нет.
  assert.equal(
    decideTrailingSlMove({ ...base, appliedTriggerR: 2.5, currentSlPrice: 105, price: 114 }).action,
    "skip",
  );
});

test("1/4: полная лестница 2→вход, 2.5→1R, 3→2R, 3.5→2.5R", () => {
  const ladder = [
    { price: 110, triggerR: 2, newSlPrice: 100 },
    { price: 112.5, triggerR: 2.5, newSlPrice: 105 },
    { price: 115, triggerR: 3, newSlPrice: 110 },
    { price: 117.5, triggerR: 3.5, newSlPrice: 112.5 },
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
      assert.equal(decision.newSlPrice, step.newSlPrice);
      applied = decision.triggerR;
      sl = decision.newSlPrice;
    }
  }
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
    price: 90, // 2R вниз
  });
  assert.deepEqual(decision, { action: "move", triggerR: 2, slR: 0, newSlPrice: 100 });
});

test("частичная фиксация задана — лестница не применяется", () => {
  const decision = decideTrailingSlMove({ ...base, partialTpPrice: 108, price: 115 });
  assert.equal(decision.action, "skip");
});

test("стоп уже не хуже целевого (ночное правило опередило) — settle без движения", () => {
  // SL уже на +1R (105), цена дошла до 2R: целевой стоп — вход (100), хуже текущего.
  const decision = decideTrailingSlMove({ ...base, currentSlPrice: 105, price: 110 });
  assert.deepEqual(decision, { action: "settle", triggerR: 2 });

  // А на 3R (1/4) целевой +2R (110) уже лучше 105 — двигаем.
  const further = decideTrailingSlMove({
    ...base,
    rrPreset: "1/4",
    currentSlPrice: 105,
    appliedTriggerR: 2.5,
    price: 115,
  });
  assert.deepEqual(further, { action: "move", triggerR: 3, slR: 2, newSlPrice: 110 });
});

test("уровни считаются от исходного риска, а не от текущего стопа", () => {
  // Стоп уже подтянут на 99, но 1R остаётся 5 (riskUsd/quantity): 2R — это 110, не раньше.
  assert.equal(decideTrailingSlMove({ ...base, currentSlPrice: 99, price: 108 }).action, "skip");
  assert.equal(decideTrailingSlMove({ ...base, currentSlPrice: 99, price: 110 }).action, "move");
});

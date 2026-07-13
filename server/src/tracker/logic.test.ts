import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPriceTick, createTrackingState } from "./logic.js";

test("long: MFE растёт по мере роста цены", () => {
  let state = createTrackingState("long", 100);
  ({ state } = applyPriceTick(state, 102));
  ({ state } = applyPriceTick(state, 105));
  const { state: after } = applyPriceTick(state, 103);
  assert.equal(after.mfePrice, 105);
});

test("long: MFE не уменьшается при откате цены", () => {
  let state = createTrackingState("long", 100);
  ({ state } = applyPriceTick(state, 110));
  const { state: after, changed } = applyPriceTick(state, 101);
  assert.equal(after.mfePrice, 110);
  assert.equal(changed, false);
});

test("long: безубыток не срабатывает, если цена сразу пошла в минус", () => {
  let state = createTrackingState("long", 100);
  const { state: after } = applyPriceTick(state, 95);
  assert.equal(after.beCrossed, false);
  assert.equal(after.hasBeenInProfit, false);
});

test("long: безубыток срабатывает после выхода в плюс и возврата к цене входа", () => {
  let state = createTrackingState("long", 100);
  ({ state } = applyPriceTick(state, 105));
  const { state: after, changed } = applyPriceTick(state, 100);
  assert.equal(after.beCrossed, true);
  assert.equal(changed, true);
});

test("long: безубыток фиксируется один раз и не сбрасывается повторно", () => {
  let state = createTrackingState("long", 100);
  ({ state } = applyPriceTick(state, 105));
  ({ state } = applyPriceTick(state, 100));
  const { state: after, changed } = applyPriceTick(state, 99);
  assert.equal(after.beCrossed, true);
  assert.equal(changed, false);
});

test("short: MFE — это минимум цены, безубыток — возврат вверх к входу", () => {
  let state = createTrackingState("short", 100);
  ({ state } = applyPriceTick(state, 95));
  assert.equal(state.mfePrice, 95);

  const { state: after, changed } = applyPriceTick(state, 100);
  assert.equal(after.beCrossed, true);
  assert.equal(changed, true);
});

test("short: движение цены вниз без возврата к входу не триггерит безубыток", () => {
  let state = createTrackingState("short", 100);
  ({ state } = applyPriceTick(state, 90));
  const { state: after } = applyPriceTick(state, 92);
  assert.equal(after.beCrossed, false);
});

test("createTrackingState допускает восстановление состояния (перезапуск сервера)", () => {
  const state = createTrackingState("long", 100, { mfePrice: 108, beCrossed: false });
  assert.equal(state.mfePrice, 108);
  assert.equal(state.hasBeenInProfit, false);
});

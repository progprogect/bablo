import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHourStats, parseHourBaseline, sumBaseline } from "./hourBaseline.js";

test("разбор: формат пользователя — с пробелами, без них, с хвостами и ведущим нулём", () => {
  const { entries, errors } = parseHourBaseline(
    ["6- 1/1", "7 - 2/5", "00 - 1/2 примерно", "01 - 0/3 примерно", "", "  "].join("\n"),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(entries, [
    { hour: 0, total: 2, tpCount: 1 },
    { hour: 1, total: 3, tpCount: 0 },
    { hour: 6, total: 1, tpCount: 1 },
    { hour: 7, total: 5, tpCount: 2 },
  ]);
});

test("разбор: мусорная строка не ломает остальные, а показывается ошибкой", () => {
  const { entries, errors } = parseHourBaseline("11 - 16/32\nвинрейт часов\n12 - 5/15");
  assert.equal(entries.length, 2);
  assert.deepEqual(errors, ["винрейт часов"]);
});

test("разбор: невозможный час и тейков больше сделок — отдельные ошибки", () => {
  const { entries, errors } = parseHourBaseline("25 - 1/2\n13 - 20/16");
  assert.deepEqual(entries, []);
  assert.equal(errors.length, 2);
  assert.match(errors[0] ?? "", /часа 25 не бывает/);
  assert.match(errors[1] ?? "", /тейков больше/);
});

test("разбор: повтор часа — побеждает последняя строка", () => {
  const { entries } = parseHourBaseline("9 - 1/5\n9 - 3/10");
  assert.deepEqual(entries, [{ hour: 9, total: 10, tpCount: 3 }]);
});

test("итоги считаются по всем часам", () => {
  const { entries } = parseHourBaseline("6 - 1/1\n7 - 2/5\n8 - 5/10");
  assert.deepEqual(sumBaseline(entries), { total: 16, tpCount: 8 });
});

test("слияние: стартовые цифры складываются с реальными сделками", () => {
  const merged = mergeHourStats(
    [
      { hour: 7, total: 2, tpCount: 1 },
      { hour: 15, total: 1, tpCount: 0 },
    ],
    [
      { hour: 7, total: 5, tpCount: 2 },
      { hour: 11, total: 32, tpCount: 16 },
    ],
  );
  assert.deepEqual(merged, [
    { hour: 7, total: 7, tpCount: 3 },
    { hour: 11, total: 32, tpCount: 16 },
    { hour: 15, total: 1, tpCount: 0 },
  ]);
});

test("слияние: часы без единой сделки в результат не попадают", () => {
  assert.deepEqual(mergeHourStats([], [{ hour: 3, total: 0, tpCount: 0 }]), []);
});

test("слияние: пустая стартовая статистика ничего не меняет", () => {
  const computed = [{ hour: 9, total: 4, tpCount: 2 }];
  assert.deepEqual(mergeHourStats(computed, []), computed);
});

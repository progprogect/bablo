import { test } from "node:test";
import assert from "node:assert/strict";
import {
  entryRiskDistance,
  initialSlPrice,
  isAnswerType,
  mfeR,
  plannedRR,
  parseChoiceOptions,
  validateAnswers,
  validateDrawings,
  validateItemsReorder,
  type AnswerValue,
  type ChecklistItemDef,
} from "./logic.js";

const items: ChecklistItemDef[] = [
  { id: 1, answerType: "yes_no", label: "Дождалась подтверждения" },
  { id: 2, answerType: "scale_0_10", label: "Качество входа" },
  { id: 3, answerType: "text", label: "Комментарий" },
];

test("validateAnswers: полный корректный набор проходит и нормализуется по колонкам", () => {
  const result = validateAnswers(items, [
    { itemId: 3, value: "  всё по плану  " },
    { itemId: 1, value: true },
    { itemId: 2, value: 7 },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Порядок — как в чек-листе, текст обрезан по краям.
  assert.deepEqual(result.normalized, [
    { itemId: 1, valueBool: true, valueInt: null, valueText: null },
    { itemId: 2, valueBool: null, valueInt: 7, valueText: null },
    { itemId: 3, valueBool: null, valueInt: null, valueText: "всё по плану" },
  ]);
});

test("validateAnswers: пропущенный пункт — ошибка с его названием", () => {
  const result = validateAnswers(items, [
    { itemId: 1, value: false },
    { itemId: 2, value: 3 },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Комментарий/);
});

test("validateAnswers: ответ на чужой пункт — ошибка", () => {
  const result = validateAnswers(items, [
    { itemId: 1, value: true },
    { itemId: 2, value: 5 },
    { itemId: 3, value: "ок" },
    { itemId: 99, value: true },
  ]);
  assert.equal(result.ok, false);
});

test("validateAnswers: двойной ответ на пункт — ошибка", () => {
  const result = validateAnswers(items, [
    { itemId: 1, value: true },
    { itemId: 1, value: false },
    { itemId: 2, value: 5 },
    { itemId: 3, value: "ок" },
  ]);
  assert.equal(result.ok, false);
});

test("validateAnswers: типы значений проверяются строго", () => {
  // Строка вместо boolean.
  assert.equal(validateAnswers(items, [
    { itemId: 1, value: "да" },
    { itemId: 2, value: 5 },
    { itemId: 3, value: "ок" },
  ]).ok, false);
  // Шкала: не целое, вне диапазона.
  assert.equal(validateAnswers(items, [
    { itemId: 1, value: true },
    { itemId: 2, value: 5.5 },
    { itemId: 3, value: "ок" },
  ]).ok, false);
  assert.equal(validateAnswers(items, [
    { itemId: 1, value: true },
    { itemId: 2, value: 11 },
    { itemId: 3, value: "ок" },
  ]).ok, false);
  assert.equal(validateAnswers(items, [
    { itemId: 1, value: true },
    { itemId: 2, value: -1 },
    { itemId: 3, value: "ок" },
  ]).ok, false);
  // Пустой текст (после trim).
  assert.equal(validateAnswers(items, [
    { itemId: 1, value: true },
    { itemId: 2, value: 5 },
    { itemId: 3, value: "   " },
  ]).ok, false);
  // Граничные значения шкалы валидны.
  assert.equal(validateAnswers(items, [
    { itemId: 1, value: true },
    { itemId: 2, value: 0 },
    { itemId: 3, value: "ок" },
  ]).ok, true);
  assert.equal(validateAnswers(items, [
    { itemId: 1, value: true },
    { itemId: 2, value: 10 },
    { itemId: 3, value: "ок" },
  ]).ok, true);
});

test("validateAnswers: пустой чек-лист — валиден без ответов", () => {
  const result = validateAnswers([], []);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.normalized, []);
});

test("isAnswerType: только три известных типа", () => {
  assert.equal(isAnswerType("yes_no"), true);
  assert.equal(isAnswerType("scale_0_10"), true);
  assert.equal(isAnswerType("text"), true);
  assert.equal(isAnswerType("multi"), false);
  assert.equal(isAnswerType(1), false);
});

// --- Геометрия сделки -------------------------------------------------------------------

const longTrade = {
  side: "long" as const,
  entryPrice: 100,
  slPrice: 99.5, // текущий стоп подтянут — НЕ исходный
  quantity: 20,
  riskUsd: 40, // исходная дистанция 1R = 40/20 = 2
};

test("entryRiskDistance: из riskUsd/qty, а не из подтянутого стопа", () => {
  assert.equal(entryRiskDistance(longTrade), 2);
  // Фолбэк на |entry − sl| для старых сделок без riskUsd.
  assert.equal(entryRiskDistance({ ...longTrade, riskUsd: null }), 0.5);
  assert.equal(entryRiskDistance({ ...longTrade, riskUsd: null, slPrice: null }), null);
});

test("initialSlPrice: восстанавливает стоп при входе по направлению", () => {
  assert.equal(initialSlPrice(longTrade), 98);
  assert.equal(initialSlPrice({ ...longTrade, side: "short" }), 102);
  assert.equal(initialSlPrice({ ...longTrade, entryPrice: null }), null);
});

test("mfeR: ход в пользу сделки в R от исходного риска", () => {
  assert.equal(mfeR(longTrade, 104), 2); // лонг: (104−100)/2
  assert.equal(mfeR({ ...longTrade, side: "short" }, 95), 2.5); // шорт: (100−95)/2
  assert.equal(mfeR(longTrade, null), null);
});

test("plannedRR: |tp − entry| / дистанция 1R", () => {
  assert.equal(plannedRR(longTrade, 104), 2);
  assert.equal(plannedRR({ ...longTrade, side: "short" }, 96), 2);
  assert.equal(plannedRR(longTrade, null), null);
});

// --- Звёзды 0–5 и переупорядочивание пунктов (23.09.2026) ---------------------------------


const starsItems: ChecklistItemDef[] = [{ id: 5, answerType: "stars_0_5", label: "Оценка сетапа" }];

test("stars_0_5: целые 0–5 валидны, включая ноль", () => {
  for (const value of [0, 1, 3, 5]) {
    assert.equal(validateAnswers(starsItems, [{ itemId: 5, value }]).ok, true, `value=${value}`);
  }
});

test("stars_0_5: дробные, вне диапазона и не числа — ошибка", () => {
  for (const value of [2.5, -1, 6, "3", true, null]) {
    assert.equal(validateAnswers(starsItems, [{ itemId: 5, value }]).ok, false, `value=${String(value)}`);
  }
});

test("validateItemsReorder: перестановка ровно всех активных пунктов", () => {
  const ok = validateItemsReorder([1, 2, 3], [3, 1, 2]);
  assert.deepEqual(ok, { ok: true, itemIds: [3, 1, 2] });
});

test("validateItemsReorder: дубли, чужие, пропуски и не-массив — ошибка", () => {
  assert.equal(validateItemsReorder([1, 2, 3], [1, 1, 2]).ok, false);
  assert.equal(validateItemsReorder([1, 2, 3], [1, 2, 4]).ok, false);
  assert.equal(validateItemsReorder([1, 2, 3], [1, 2]).ok, false);
  assert.equal(validateItemsReorder([1, 2, 3], "1,2,3").ok, false);
  assert.equal(validateItemsReorder([1, 2, 3], [1, 2, "3"]).ok, false);
});

test("validateDrawings: корректный набор проходит, мусор — нет", () => {
  const ok = validateDrawings([{ id: "a", t1: 1, p1: 2, t2: 3, p2: 4 }]);
  assert.equal(ok.ok, true);
  assert.equal(validateDrawings("nope").ok, false);
  assert.equal(validateDrawings([{ id: "", t1: 1, p1: 2, t2: 3, p2: 4 }]).ok, false);
  assert.equal(validateDrawings([{ id: "a", t1: Infinity, p1: 2, t2: 3, p2: 4 }]).ok, false);
  assert.equal(validateDrawings([{ id: "a", t1: 1, p1: 2, t2: 3, p2: "4" }]).ok, false);
  // Дубль id.
  assert.equal(
    validateDrawings([
      { id: "a", t1: 1, p1: 2, t2: 3, p2: 4 },
      { id: "a", t1: 5, p1: 6, t2: 7, p2: 8 },
    ]).ok,
    false,
  );
  // Пустой массив валиден — «стереть все линии».
  assert.equal(validateDrawings([]).ok, true);
});

// --- Тип «выбор из вариантов» (23.09.2026) --------------------------------------------------


const choiceItems: ChecklistItemDef[] = [
  { id: 7, answerType: "choice", label: "Тип сетапа", options: ["Пробой", "Отбой", "Ретест"] },
];

test("choice: вариант из списка валиден, чужой и не-строка — нет", () => {
  assert.equal(validateAnswers(choiceItems, [{ itemId: 7, value: "Отбой" }]).ok, true);
  assert.equal(validateAnswers(choiceItems, [{ itemId: 7, value: "Флет" }]).ok, false);
  assert.equal(validateAnswers(choiceItems, [{ itemId: 7, value: 1 }]).ok, false);
});

test("parseChoiceOptions: строка через запятую → trim, пустые отброшены", () => {
  assert.deepEqual(parseChoiceOptions(" Пробой, Отбой , ,Ретест "), {
    ok: true,
    options: ["Пробой", "Отбой", "Ретест"],
  });
  assert.deepEqual(parseChoiceOptions(["A", "B"]), { ok: true, options: ["A", "B"] });
});

test("parseChoiceOptions: дубли, мало вариантов и мусор — ошибка", () => {
  assert.equal(parseChoiceOptions("A, a").ok, false);
  assert.equal(parseChoiceOptions("Один").ok, false);
  assert.equal(parseChoiceOptions(42).ok, false);
  assert.equal(parseChoiceOptions("A,B,C,D,E,F,G,H,I,J,K").ok, false);
});

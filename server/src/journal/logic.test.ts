import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAnalysisAggregates,
  entryRiskDistance,
  initialSlPrice,
  isAnswerType,
  mfeR,
  plannedRR,
  validateAnswers,
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

// --- Агрегаты таблицы анализа -----------------------------------------------------------

function answers(map: Record<number, AnswerValue>): ReadonlyMap<number, AnswerValue> {
  return new Map(Object.entries(map).map(([k, v]) => [Number(k), v]));
}

test("buildAnalysisAggregates: разрез плюс/минус, нулевые и безрезультатные сделки вне разрезов", () => {
  const rows = [
    { resultR: 2, answers: answers({ 1: true, 2: 8, 3: "ок" }) },
    { resultR: 1, answers: answers({ 1: true, 2: 6, 3: "норм" }) },
    { resultR: -1, answers: answers({ 1: false, 2: 3, 3: "рано вошла" }) },
    { resultR: 0, answers: answers({ 1: true, 2: 10, 3: "бу" }) }, // безубыток — вне разрезов
    { resultR: null, answers: answers({ 1: true, 2: 10, 3: "?" }) }, // нет R — вне разрезов
  ];
  const { plus, minus } = buildAnalysisAggregates(items, rows);

  assert.equal(plus.tradesCount, 2);
  assert.deepEqual(plus.byItem[1], { kind: "yes_no", yesCount: 2, total: 2 });
  assert.deepEqual(plus.byItem[2], { kind: "scale", average: 7, total: 2 });
  assert.deepEqual(plus.byItem[3], { kind: "text", total: 2 });

  assert.equal(minus.tradesCount, 1);
  assert.deepEqual(minus.byItem[1], { kind: "yes_no", yesCount: 0, total: 1 });
  assert.deepEqual(minus.byItem[2], { kind: "scale", average: 3, total: 1 });
});

test("buildAnalysisAggregates: пропущенные ответы (архивный пункт) не искажают среднее", () => {
  const rows = [
    { resultR: 2, answers: answers({ 2: 8 }) }, // на пункт 1 не отвечали
    { resultR: 3, answers: answers({ 1: true, 2: 4 }) },
  ];
  const { plus } = buildAnalysisAggregates(items, rows);
  assert.deepEqual(plus.byItem[1], { kind: "yes_no", yesCount: 1, total: 1 });
  assert.deepEqual(plus.byItem[2], { kind: "scale", average: 6, total: 2 });
});

test("buildAnalysisAggregates: пустая группа — нули и null-среднее", () => {
  const { minus } = buildAnalysisAggregates(items, [
    { resultR: 1, answers: answers({ 1: true, 2: 5, 3: "ок" }) },
  ]);
  assert.equal(minus.tradesCount, 0);
  assert.deepEqual(minus.byItem[2], { kind: "scale", average: null, total: 0 });
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

test("stars_0_5: агрегируется как среднее (kind scale)", () => {
  const rows = [
    { resultR: 1, answers: answers({ 5: 4 }) },
    { resultR: 2, answers: answers({ 5: 5 }) },
    { resultR: -1, answers: answers({ 5: 1 }) },
  ];
  const { plus, minus } = buildAnalysisAggregates(starsItems, rows);
  assert.deepEqual(plus.byItem[5], { kind: "scale", average: 4.5, total: 2 });
  assert.deepEqual(minus.byItem[5], { kind: "scale", average: 1, total: 1 });
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

/**
 * Чистая логика журнала разбора сделок — без I/O, под юнит-тестами (logic.test.ts),
 * по тому же принципу, что risk/limits.ts и history/outcome.ts.
 */

export const ANSWER_TYPES = ["yes_no", "scale_0_10", "stars_0_5", "choice", "text"] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];

export function isAnswerType(value: unknown): value is AnswerType {
  return typeof value === "string" && (ANSWER_TYPES as readonly string[]).includes(value);
}

export const SCALE_MIN = 0;
export const SCALE_MAX = 10;
/** Оценка звёздами: 0–5 (запрос пользователя от 23.09.2026), хранится в value_int. */
export const STARS_MIN = 0;
export const STARS_MAX = 5;
/** Предел текстового ответа — страховка от случайной простыни, а не продуктовый лимит. */
export const TEXT_ANSWER_MAX_LENGTH = 2000;

export type ChecklistItemDef = {
  id: number;
  answerType: AnswerType;
  label: string;
  /** Только для answerType='choice': допустимые варианты ответа. */
  options?: string[];
};

/** Ограничения вариантов пункта-«выбора». */
export const CHOICE_MIN_OPTIONS = 2;
export const CHOICE_MAX_OPTIONS = 10;
export const CHOICE_OPTION_MAX_LENGTH = 40;

export type ChoiceOptionsResult = { ok: true; options: string[] } | { ok: false; error: string };

/**
 * Варианты пункта-«выбора» из ввода конструктора (строки через запятую или массив):
 * trim, пустые отбрасываются, дубли и превышения — ошибка.
 */
export function parseChoiceOptions(raw: unknown): ChoiceOptionsResult {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : null;
  if (parts === null) return { ok: false, error: "Варианты — строка через запятую или массив" };
  const options: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (typeof part !== "string") return { ok: false, error: "Вариант — строка" };
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > CHOICE_OPTION_MAX_LENGTH) {
      return { ok: false, error: `Вариант не длиннее ${CHOICE_OPTION_MAX_LENGTH} символов` };
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `Вариант «${trimmed}» повторяется` };
    seen.add(key);
    options.push(trimmed);
  }
  if (options.length < CHOICE_MIN_OPTIONS || options.length > CHOICE_MAX_OPTIONS) {
    return { ok: false, error: `Вариантов должно быть от ${CHOICE_MIN_OPTIONS} до ${CHOICE_MAX_OPTIONS}` };
  }
  return { ok: true, options };
}

export type AnswerInput = {
  itemId: number;
  value: unknown;
};

/** Значение ответа, разложенное по типизированным колонкам journal_answers. */
export type NormalizedAnswer = {
  itemId: number;
  valueBool: boolean | null;
  valueInt: number | null;
  valueText: string | null;
};

export type ValidationResult =
  | { ok: true; normalized: NormalizedAnswer[] }
  | { ok: false; error: string };

/**
 * Проверяет ответы на чек-лист категории: отвечен КАЖДЫЙ активный пункт, ровно по разу,
 * значение соответствует типу пункта. Правило «обязан ответить на всё» — серверное:
 * клиентская блокировка кнопки, как и везде в приложении, лишь дублирует его.
 */
export function validateAnswers(activeItems: ChecklistItemDef[], answers: AnswerInput[]): ValidationResult {
  const itemsById = new Map(activeItems.map((item) => [item.id, item]));
  const normalizedById = new Map<number, NormalizedAnswer>();

  for (const answer of answers) {
    const item = itemsById.get(answer.itemId);
    if (!item) {
      return { ok: false, error: `Пункт #${answer.itemId} не входит в чек-лист выбранной категории` };
    }
    if (normalizedById.has(item.id)) {
      return { ok: false, error: `Пункт «${item.label}» отвечен дважды` };
    }
    const normalized = normalizeValue(item, answer.value);
    if (normalized === null) {
      return { ok: false, error: `Пункт «${item.label}»: недопустимый ответ` };
    }
    normalizedById.set(item.id, normalized);
  }

  const missing = activeItems.filter((item) => !normalizedById.has(item.id));
  if (missing.length > 0) {
    const labels = missing.map((item) => `«${item.label}»`).join(", ");
    return { ok: false, error: `Нет ответа на пункты: ${labels}` };
  }

  // Порядок — как в чек-листе, а не как прислал клиент.
  const normalized = activeItems.map((item) => normalizedById.get(item.id)!);
  return { ok: true, normalized };
}

function normalizeValue(item: ChecklistItemDef, value: unknown): NormalizedAnswer | null {
  switch (item.answerType) {
    case "yes_no":
      if (typeof value !== "boolean") return null;
      return { itemId: item.id, valueBool: value, valueInt: null, valueText: null };
    case "scale_0_10": {
      if (typeof value !== "number" || !Number.isInteger(value)) return null;
      if (value < SCALE_MIN || value > SCALE_MAX) return null;
      return { itemId: item.id, valueBool: null, valueInt: value, valueText: null };
    }
    case "stars_0_5": {
      if (typeof value !== "number" || !Number.isInteger(value)) return null;
      if (value < STARS_MIN || value > STARS_MAX) return null;
      return { itemId: item.id, valueBool: null, valueInt: value, valueText: null };
    }
    case "choice": {
      if (typeof value !== "string") return null;
      // Только вариант из списка пункта — ответ хранится этой же строкой в value_text.
      if (!item.options || !item.options.includes(value)) return null;
      return { itemId: item.id, valueBool: null, valueInt: null, valueText: value };
    }
    case "text": {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      if (trimmed.length === 0 || trimmed.length > TEXT_ANSWER_MAX_LENGTH) return null;
      return { itemId: item.id, valueBool: null, valueInt: null, valueText: trimmed };
    }
  }
}

// --- Производные величины сделки для «картины сделки» -----------------------------------

export type TradeGeometry = {
  side: "long" | "short";
  entryPrice: number | null;
  slPrice: number | null;
  quantity: number | null;
  riskUsd: number | null;
};

/**
 * Дистанция 1R, с которой ВОШЛИ в сделку: riskUsd / объём. Текущий slPrice — только
 * запасной путь для старых сделок без riskUsd: стоп мог быть подтянут трейлингом или
 * ночным правилом, и его дистанция уже не равна исходному риску. Синхронно с
 * entryRiskDistance на клиенте (ActiveTradeCard) и расчётами трейлинга/ночного правила.
 */
export function entryRiskDistance(trade: TradeGeometry): number | null {
  const quantity = trade.quantity ?? NaN;
  const riskUsd = trade.riskUsd ?? NaN;
  if (Number.isFinite(riskUsd) && riskUsd > 0 && Number.isFinite(quantity) && quantity > 0) {
    return riskUsd / quantity;
  }
  const entry = trade.entryPrice ?? NaN;
  const sl = trade.slPrice ?? NaN;
  if (!Number.isFinite(entry) || !Number.isFinite(sl)) return null;
  const distance = Math.abs(entry - sl);
  return distance > 0 ? distance : null;
}

/**
 * Стоп ПРИ ВХОДЕ, восстановленный из исходного риска: в trades хранится только текущий
 * slPrice, который двигают трейлинг-лестница и ночное правило. entry ± (riskUsd/qty)
 * даёт цену, с которой сделка реально стартовала.
 */
export function initialSlPrice(trade: TradeGeometry): number | null {
  const entry = trade.entryPrice ?? NaN;
  const distance = entryRiskDistance(trade);
  if (!Number.isFinite(entry) || distance === null) return null;
  return trade.side === "long" ? entry - distance : entry + distance;
}

/** Максимальный ход цены в пользу сделки (MFE) в R от исходного риска. */
export function mfeR(trade: TradeGeometry, mfePrice: number | null): number | null {
  const entry = trade.entryPrice ?? NaN;
  const distance = entryRiskDistance(trade);
  if (mfePrice === null || !Number.isFinite(entry) || distance === null) return null;
  const move = trade.side === "long" ? mfePrice - entry : entry - mfePrice;
  return move / distance;
}

/** Соотношение риск/прибыль по плану входа: |tpPriceInitial − entry| / дистанция 1R. */
export function plannedRR(trade: TradeGeometry, tpPriceInitial: number | null): number | null {
  const entry = trade.entryPrice ?? NaN;
  const distance = entryRiskDistance(trade);
  if (tpPriceInitial === null || !Number.isFinite(entry) || distance === null) return null;
  return Math.abs(tpPriceInitial - entry) / distance;
}

/** Значение ответа наружу (детали, таблица анализа): тип по answer_type пункта. */
export type AnswerValue = boolean | number | string;

// --- Переупорядочивание пунктов чек-листа (drag-and-drop в конструкторе) -----------------

export type ReorderResult = { ok: true; itemIds: number[] } | { ok: false; error: string };

/**
 * Проверяет запрошенный порядок пунктов: это должна быть перестановка РОВНО всех активных
 * пунктов категории — без дублей, чужих и пропущенных id. Иначе частичный список молча
 * перетасовал бы sort_order относительно невключённых пунктов.
 */
export function validateItemsReorder(activeItemIds: number[], requested: unknown): ReorderResult {
  if (!Array.isArray(requested) || !requested.every((id) => Number.isInteger(id))) {
    return { ok: false, error: "Порядок пунктов — массив их id" };
  }
  const itemIds = requested as number[];
  const requestedSet = new Set(itemIds);
  if (requestedSet.size !== itemIds.length) {
    return { ok: false, error: "В порядке пунктов есть дубли" };
  }
  const activeSet = new Set(activeItemIds);
  if (requestedSet.size !== activeSet.size || itemIds.some((id) => !activeSet.has(id))) {
    return { ok: false, error: "Порядок должен включать все пункты чек-листа и только их" };
  }
  return { ok: true, itemIds };
}

// --- Линии пользователя на графике сделки --------------------------------------------------

export const MAX_DRAWINGS_PER_TRADE = 200;

export type DrawingInput = { id: string; t1: number; p1: number; t2: number; p2: number };

export type DrawingsValidation =
  | { ok: true; drawings: DrawingInput[] }
  | { ok: false; error: string };

/** Линии рабочей зоны: id-строка и четыре конечных числа (time ms, цена) на линию. */
export function validateDrawings(requested: unknown): DrawingsValidation {
  if (!Array.isArray(requested)) return { ok: false, error: "Линии — массив" };
  if (requested.length > MAX_DRAWINGS_PER_TRADE) {
    return { ok: false, error: `Не больше ${MAX_DRAWINGS_PER_TRADE} линий на сделку` };
  }
  const drawings: DrawingInput[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "Линия — объект" };
    const { id, t1, p1, t2, p2 } = raw as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0 || id.length > 40 || seen.has(id)) {
      return { ok: false, error: "У каждой линии — уникальный строковый id" };
    }
    const nums = [t1, p1, t2, p2];
    if (!nums.every((value) => typeof value === "number" && Number.isFinite(value))) {
      return { ok: false, error: "Координаты линии — конечные числа" };
    }
    seen.add(id);
    drawings.push({ id, t1: t1 as number, p1: p1 as number, t2: t2 as number, p2: p2 as number });
  }
  return { ok: true, drawings };
}

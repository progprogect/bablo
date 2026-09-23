import type { FastifyInstance } from "fastify";
import { requireAuth } from "../api/plugins/auth-guard.js";
import { getTradeById } from "../db/repositories/trades.js";
import {
  ANSWER_TYPES,
  isAnswerType,
  parseChoiceOptions,
  validateAnswers,
  validateDrawings,
  validateItemsReorder,
  type AnswerInput,
  type AnswerType,
  type ChecklistItemDef,
} from "./logic.js";
import {
  answerValue,
  countActiveItemsByCategory,
  countEntriesByCategory,
  countUnsortedTrades,
  createCategory,
  createItem,
  deleteEntry,
  deleteOrArchiveCategory,
  deleteOrArchiveItem,
  getActiveCategory,
  getCategoryAny,
  getEntryWithAnswers,
  itemIdsWithAnswers,
  listActiveCategories,
  listActiveItems,
  listAllItems,
  listAnalysisRows,
  listJournalTrades,
  renameCategory,
  renameItem,
  reorderItems,
  upsertEntry,
  type JournalTradesFilter,
} from "./repository.js";
import { toTradeCard, toTradeDetail } from "./view.js";
import {
  ensureTradeCandles,
  extendTradeCandlesBack,
  intervalConfig,
  tradeCandleWindow,
  type CandleIntervalConfig,
} from "./marketData.js";
import { getCandleSync, getDrawings, listCandles, saveDrawings } from "./marketRepository.js";
import { buildStructure } from "./structure.js";

const DEFAULT_LIMIT = 50;

/** options пункта из jsonb: массив строк или null (не-choice пункты). */
function itemOptions(raw: unknown): string[] | undefined {
  return Array.isArray(raw) && raw.every((value) => typeof value === "string")
    ? (raw as string[])
    : undefined;
}
const MAX_LIMIT = 200;
const MAX_CATEGORY_NAME_LENGTH = 60;
const MAX_ITEM_LABEL_LENGTH = 120;

/**
 * API журнала разбора сделок (/journal — отдельная PWA «Bablo.Дневник»). Журнал живёт
 * сбоку от торгового контура: из основных данных только читает trades, всё состояние —
 * в таблицах journal_* (см. journal/schema.ts). Торговых путей и риск-движка не касается.
 */
export async function registerJournalRoutes(app: FastifyInstance): Promise<void> {
  // --- Обзор для чипов фильтра и экрана «Анализ» ---------------------------------------

  app.get("/journal/overview", { preHandler: requireAuth }, async () => {
    const [categories, unsortedCount, entriesByCategory, itemsByCategory] = await Promise.all([
      listActiveCategories(),
      countUnsortedTrades(),
      countEntriesByCategory(),
      countActiveItemsByCategory(),
    ]);
    return {
      unsortedCount,
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        tradesCount: entriesByCategory.get(category.id) ?? 0,
        itemsCount: itemsByCategory.get(category.id) ?? 0,
      })),
    };
  });

  // --- Лента сделок ---------------------------------------------------------------------

  app.get<{ Querystring: { filter?: string; limit?: string; offset?: string } }>(
    "/journal/trades",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { filter: rawFilter, limit: rawLimit, offset: rawOffset } = request.query;
      const limit = Math.min(Math.max(Number(rawLimit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
      const offset = Math.max(Number(rawOffset) || 0, 0);

      let filter: JournalTradesFilter;
      if (rawFilter === undefined || rawFilter === "unsorted") {
        filter = { kind: "unsorted" };
      } else if (rawFilter === "all") {
        filter = { kind: "all" };
      } else if (/^\d+$/.test(rawFilter)) {
        filter = { kind: "category", categoryId: Number(rawFilter) };
      } else {
        reply.code(400).send({ error: "Неизвестный фильтр" });
        return;
      }

      const { rows, total } = await listJournalTrades(filter, { limit, offset });
      return {
        trades: rows.map((row) => toTradeCard(row.trade, row.categoryId)),
        total,
      };
    },
  );

  // --- Деталь сделки с разбором -----------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/journal/trades/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const tradeId = Number(request.params.id);
      if (!Number.isInteger(tradeId)) {
        reply.code(400).send({ error: "Некорректный id сделки" });
        return;
      }
      const trade = await getTradeById(tradeId);
      if (!trade || trade.status !== "closed") {
        reply.code(404).send({ error: "Сделка не найдена" });
        return;
      }
      const entryBlock = await buildEntryBlock(tradeId);
      return {
        trade: toTradeDetail(trade, entryBlock?.categoryId ?? null),
        entry: entryBlock,
      };
    },
  );

  // --- Сохранение разбора -----------------------------------------------------------------

  app.put<{ Params: { id: string }; Body: { categoryId?: number; answers?: AnswerInput[] } }>(
    "/journal/trades/:id/entry",
    { preHandler: requireAuth },
    async (request, reply) => {
      const tradeId = Number(request.params.id);
      if (!Number.isInteger(tradeId)) {
        reply.code(400).send({ error: "Некорректный id сделки" });
        return;
      }
      const trade = await getTradeById(tradeId);
      if (!trade || trade.status !== "closed") {
        reply.code(404).send({ error: "Сделка не найдена" });
        return;
      }

      const { categoryId, answers } = request.body ?? {};
      if (!Number.isInteger(categoryId)) {
        reply.code(400).send({ error: "Выберите категорию" });
        return;
      }
      const category = await getActiveCategory(categoryId as number);
      if (!category) {
        reply.code(400).send({ error: "Категория не найдена или в архиве" });
        return;
      }
      if (!Array.isArray(answers)) {
        reply.code(400).send({ error: "Нет ответов на чек-лист" });
        return;
      }

      const activeItems = await listActiveItems(category.id);
      const itemDefs: ChecklistItemDef[] = activeItems.map((item) => ({
        id: item.id,
        label: item.label,
        answerType: item.answerType as AnswerType,
        options: itemOptions(item.options),
      }));
      const validated = validateAnswers(itemDefs, answers);
      if (!validated.ok) {
        reply.code(400).send({ error: validated.error });
        return;
      }

      await upsertEntry(tradeId, category.id, validated.normalized);
      const entryBlock = await buildEntryBlock(tradeId);
      return {
        trade: toTradeDetail(trade, entryBlock?.categoryId ?? null),
        entry: entryBlock,
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/journal/trades/:id/entry",
    { preHandler: requireAuth },
    async (request, reply) => {
      const tradeId = Number(request.params.id);
      if (!Number.isInteger(tradeId)) {
        reply.code(400).send({ error: "Некорректный id сделки" });
        return;
      }
      await deleteEntry(tradeId);
      reply.code(204).send();
    },
  );

  // --- Конструктор категорий и чек-листов --------------------------------------------------

  app.get("/journal/categories", { preHandler: requireAuth }, async () => {
    const [categories, entriesByCategory] = await Promise.all([
      listActiveCategories(),
      countEntriesByCategory(),
    ]);
    const result = [];
    for (const category of categories) {
      const items = await listActiveItems(category.id);
      const withAnswers = await itemIdsWithAnswers(items.map((item) => item.id));
      result.push({
        id: category.id,
        name: category.name,
        entriesCount: entriesByCategory.get(category.id) ?? 0,
        items: items.map((item) => ({
          id: item.id,
          label: item.label,
          answerType: item.answerType,
          options: itemOptions(item.options),
          hasAnswers: withAnswers.has(item.id),
        })),
      });
    }
    return { categories: result };
  });

  app.post<{ Body: { name?: string } }>(
    "/journal/categories",
    { preHandler: requireAuth },
    async (request, reply) => {
      const name = normalizeName(request.body?.name, MAX_CATEGORY_NAME_LENGTH);
      if (!name) {
        reply.code(400).send({ error: "Укажите название категории" });
        return;
      }
      const existing = await listActiveCategories();
      if (existing.some((category) => category.name.toLowerCase() === name.toLowerCase())) {
        reply.code(400).send({ error: "Категория с таким названием уже есть" });
        return;
      }
      const created = await createCategory(name);
      return { id: created.id, name: created.name };
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string } }>(
    "/journal/categories/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = Number(request.params.id);
      const name = normalizeName(request.body?.name, MAX_CATEGORY_NAME_LENGTH);
      if (!Number.isInteger(id) || !name) {
        reply.code(400).send({ error: "Укажите название категории" });
        return;
      }
      const existing = await listActiveCategories();
      if (existing.some((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) {
        reply.code(400).send({ error: "Категория с таким названием уже есть" });
        return;
      }
      const updated = await renameCategory(id, name);
      if (!updated) {
        reply.code(404).send({ error: "Категория не найдена" });
        return;
      }
      return { id: updated.id, name: updated.name };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/journal/categories/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        reply.code(400).send({ error: "Некорректный id категории" });
        return;
      }
      const result = await deleteOrArchiveCategory(id);
      if (!result) {
        reply.code(404).send({ error: "Категория не найдена" });
        return;
      }
      return result;
    },
  );

  app.post<{ Params: { id: string }; Body: { label?: string; answerType?: string; options?: unknown } }>(
    "/journal/categories/:id/items",
    { preHandler: requireAuth },
    async (request, reply) => {
      const categoryId = Number(request.params.id);
      const label = normalizeName(request.body?.label, MAX_ITEM_LABEL_LENGTH);
      const answerType = request.body?.answerType;
      if (!Number.isInteger(categoryId) || !label) {
        reply.code(400).send({ error: "Укажите текст пункта" });
        return;
      }
      if (!isAnswerType(answerType)) {
        reply.code(400).send({ error: `Тип ответа — один из: ${ANSWER_TYPES.join(", ")}` });
        return;
      }
      // Варианты обязательны для «выбора» и фиксируются при создании — как и сам тип.
      let options: string[] | null = null;
      if (answerType === "choice") {
        const parsed = parseChoiceOptions(request.body?.options);
        if (!parsed.ok) {
          reply.code(400).send({ error: parsed.error });
          return;
        }
        options = parsed.options;
      }
      const category = await getActiveCategory(categoryId);
      if (!category) {
        reply.code(404).send({ error: "Категория не найдена" });
        return;
      }
      const created = await createItem(categoryId, label, answerType, options);
      return {
        id: created.id,
        label: created.label,
        answerType: created.answerType,
        options: itemOptions(created.options),
      };
    },
  );

  // Порядок пунктов чек-листа — drag-and-drop в конструкторе (23.09.2026).
  app.put<{ Params: { id: string }; Body: { itemIds?: unknown } }>(
    "/journal/categories/:id/items-order",
    { preHandler: requireAuth },
    async (request, reply) => {
      const categoryId = Number(request.params.id);
      if (!Number.isInteger(categoryId)) {
        reply.code(400).send({ error: "Некорректный id категории" });
        return;
      }
      const category = await getActiveCategory(categoryId);
      if (!category) {
        reply.code(404).send({ error: "Категория не найдена" });
        return;
      }
      const activeItems = await listActiveItems(categoryId);
      const validated = validateItemsReorder(
        activeItems.map((item) => item.id),
        request.body?.itemIds,
      );
      if (!validated.ok) {
        reply.code(400).send({ error: validated.error });
        return;
      }
      await reorderItems(categoryId, validated.itemIds);
      return { ok: true };
    },
  );

  app.patch<{ Params: { id: string }; Body: { label?: string } }>(
    "/journal/items/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = Number(request.params.id);
      const label = normalizeName(request.body?.label, MAX_ITEM_LABEL_LENGTH);
      if (!Number.isInteger(id) || !label) {
        reply.code(400).send({ error: "Укажите текст пункта" });
        return;
      }
      const updated = await renameItem(id, label);
      if (!updated) {
        reply.code(404).send({ error: "Пункт не найден" });
        return;
      }
      return { id: updated.id, label: updated.label };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/journal/items/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        reply.code(400).send({ error: "Некорректный id пункта" });
        return;
      }
      const result = await deleteOrArchiveItem(id);
      if (!result) {
        reply.code(404).send({ error: "Пункт не найден" });
        return;
      }
      return result;
    },
  );

  // --- График сделки: свечи + линии рабочей зоны --------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { interval?: string } }>(
    "/journal/trades/:id/chart",
    { preHandler: requireAuth },
    async (request, reply) => {
      const tradeId = Number(request.params.id);
      const config = intervalConfig(request.query.interval ?? "15m");
      if (!Number.isInteger(tradeId) || !config) {
        reply.code(400).send({ error: "Некорректный запрос графика" });
        return;
      }
      const trade = await getTradeById(tradeId);
      if (!trade || trade.status !== "closed") {
        reply.code(404).send({ error: "Сделка не найдена" });
        return;
      }
      // Ленивый добор: обычно окно уже собрано (закрытие сделки / бэкфилл), но для
      // только что задеплоенных или пропущенных сделок дособираем событийно здесь.
      // Сбой биржи не валит запрос — отдаём, что есть в кэше.
      try {
        await ensureTradeCandles(trade, config);
      } catch (error) {
        request.log.warn({ error, tradeId }, "Журнал: не удалось дособрать свечи (отдаём кэш)");
      }
      return buildChartResponse(tradeId, trade.symbol, config, trade);
    },
  );

  // Догрузка истории влево: пользователь дотянул график за край данных (pull-to-load).
  // Событийный REST к публичным klines, свечи — в тот же вечный кэш.
  app.post<{ Params: { id: string }; Body: { interval?: string } }>(
    "/journal/trades/:id/chart/extend",
    { preHandler: requireAuth },
    async (request, reply) => {
      const tradeId = Number(request.params.id);
      const config = intervalConfig(request.body?.interval ?? "");
      if (!Number.isInteger(tradeId) || !config) {
        reply.code(400).send({ error: "Некорректный запрос догрузки" });
        return;
      }
      const trade = await getTradeById(tradeId);
      if (!trade || trade.status !== "closed") {
        reply.code(404).send({ error: "Сделка не найдена" });
        return;
      }
      let added = 0;
      let exhausted = false;
      try {
        const result = await extendTradeCandlesBack(trade, config);
        added = result.added;
        exhausted = result.exhausted;
      } catch (error) {
        request.log.warn({ error, tradeId }, "Журнал: догрузка истории не удалась");
        reply.code(502).send({ error: "Биржа не ответила — попробуй ещё раз" });
        return;
      }
      const response = await buildChartResponse(tradeId, trade.symbol, config, trade);
      return { ...response, added, exhausted };
    },
  );

  app.put<{ Params: { id: string }; Body: { drawings?: unknown } }>(
    "/journal/trades/:id/drawings",
    { preHandler: requireAuth },
    async (request, reply) => {
      const tradeId = Number(request.params.id);
      if (!Number.isInteger(tradeId)) {
        reply.code(400).send({ error: "Некорректный id сделки" });
        return;
      }
      const trade = await getTradeById(tradeId);
      if (!trade || trade.status !== "closed") {
        reply.code(404).send({ error: "Сделка не найдена" });
        return;
      }
      const validated = validateDrawings(request.body?.drawings);
      if (!validated.ok) {
        reply.code(400).send({ error: validated.error });
        return;
      }
      await saveDrawings(tradeId, validated.drawings);
      return { ok: true };
    },
  );

  // --- Таблица анализа по категории --------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/journal/analysis/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const categoryId = Number(request.params.id);
      if (!Number.isInteger(categoryId)) {
        reply.code(400).send({ error: "Некорректный id категории" });
        return;
      }
      const category = await getCategoryAny(categoryId);
      if (!category) {
        reply.code(404).send({ error: "Категория не найдена" });
        return;
      }

      const [allItems, entryRows] = await Promise.all([
        listAllItems(categoryId),
        listAnalysisRows(categoryId),
      ]);

      const answeredItemIds = new Set<number>();
      for (const row of entryRows) {
        for (const answer of row.answers) answeredItemIds.add(answer.itemId);
      }
      // Колонки: активные пункты всегда, архивные — только если по ним есть ответы.
      const columns = allItems.filter((item) => item.archivedAt === null || answeredItemIds.has(item.id));
      const rows = entryRows.map((row) => {
        const card = toTradeCard(row.trade, categoryId);
        const answers: Record<number, boolean | number | string> = {};
        for (const answer of row.answers) {
          const value = answerValue(answer);
          if (value !== null) answers[answer.itemId] = value;
        }
        return {
          tradeId: card.id,
          symbol: card.symbol,
          side: card.side,
          closedAt: card.closedAt,
          outcome: card.outcome,
          statsResultR: card.statsResultR,
          resultUsd: card.resultUsd,
          answers,
        };
      });

      return {
        category: { id: category.id, name: category.name, archived: category.archivedAt !== null },
        columns: columns.map((item) => ({
          itemId: item.id,
          label: item.label,
          answerType: item.answerType,
          options: itemOptions(item.options),
          archived: item.archivedAt !== null,
        })),
        rows,
        // Агрегаты «В плюсе/В минусе» сервер больше не считает: с появлением фильтров
        // таблицы (23.09.2026) честные цифры — только по видимым строкам, это чисто
        // презентационная логика клиента (aggregateGroup в CategoryTable.tsx).
      };
    },
  );
}

/**
 * Ответ графика: свечи фактического окна (from_time из journal_candle_syncs — окно могло
 * быть расширено догрузкой), структура и линии. Общий для GET графика и POST догрузки.
 */
async function buildChartResponse(
  tradeId: number,
  symbol: string,
  config: CandleIntervalConfig,
  trade: Parameters<typeof tradeCandleWindow>[0],
) {
  const base = tradeCandleWindow(trade, config);
  const sync = await getCandleSync(tradeId, config.key);
  const fromMs = sync ? Math.min(sync.fromTime.getTime(), base.fromMs) : base.fromMs;
  const toMs = sync ? Math.max(sync.toTime.getTime(), base.toMs) : base.toMs;
  const [candles, drawings] = await Promise.all([
    listCandles(symbol, config.key, fromMs, toMs),
    getDrawings(tradeId),
  ]);
  return {
    interval: config.key,
    stepMs: config.stepMs,
    range: { fromMs, toMs },
    candles: candles.map((candle) => ({
      t: candle.time,
      o: candle.open,
      h: candle.high,
      l: candle.low,
      c: candle.close,
      v: candle.volume,
    })),
    // Уровни, зоны накопления и сломы структуры — рисуются в рабочей зоне
    // (переключатель «Структура»); считаются чистыми функциями по свечам окна.
    structure: buildStructure(candles),
    drawings,
  };
}

/** Блок разбора для детали сделки: категория + ответы с метаданными пунктов. */
async function buildEntryBlock(tradeId: number) {
  const entryWithAnswers = await getEntryWithAnswers(tradeId);
  if (!entryWithAnswers) return null;
  const { entry, answers } = entryWithAnswers;
  const [category, items] = await Promise.all([
    getCategoryAny(entry.categoryId),
    listAllItems(entry.categoryId),
  ]);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return {
    categoryId: entry.categoryId,
    categoryName: category?.name ?? "—",
    categoryArchived: category !== null && category.archivedAt !== null,
    categorizedAt: entry.categorizedAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    answers: answers
      .map((answer) => {
        const item = itemsById.get(answer.itemId);
        return {
          itemId: answer.itemId,
          label: item?.label ?? `Пункт #${answer.itemId}`,
          answerType: (item?.answerType ?? "text") as AnswerType,
          itemArchived: item ? item.archivedAt !== null : true,
          value: answerValue(answer),
        };
      })
      .sort((a, b) => {
        const orderA = itemsById.get(a.itemId)?.sortOrder ?? 0;
        const orderB = itemsById.get(b.itemId)?.sortOrder ?? 0;
        return orderA - orderB || a.itemId - b.itemId;
      }),
  };
}

function normalizeName(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

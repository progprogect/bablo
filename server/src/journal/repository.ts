import { and, asc, count, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { trades } from "../db/schema.js";
import type { Trade } from "../db/repositories/trades.js";
import { journalAnswers, journalCategories, journalChecklistItems, journalEntries } from "./schema.js";
import type { AnswerType, AnswerValue, NormalizedAnswer } from "./logic.js";

export type JournalCategory = typeof journalCategories.$inferSelect;
export type JournalChecklistItem = typeof journalChecklistItems.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type JournalAnswerRow = typeof journalAnswers.$inferSelect;

/** Значение ответа из типизированных колонок — ровно одна не-null по типу пункта. */
export function answerValue(row: {
  valueBool: boolean | null;
  valueInt: number | null;
  valueText: string | null;
}): AnswerValue | null {
  if (row.valueBool !== null) return row.valueBool;
  if (row.valueInt !== null) return row.valueInt;
  if (row.valueText !== null) return row.valueText;
  return null;
}

// --- Категории ---------------------------------------------------------------------------

export async function listActiveCategories(): Promise<JournalCategory[]> {
  const db = getDb();
  return db
    .select()
    .from(journalCategories)
    .where(isNull(journalCategories.archivedAt))
    .orderBy(asc(journalCategories.sortOrder), asc(journalCategories.id));
}

export async function getActiveCategory(id: number): Promise<JournalCategory | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(journalCategories)
    .where(and(eq(journalCategories.id, id), isNull(journalCategories.archivedAt)))
    .limit(1);
  return row ?? null;
}

/** Категория для таблицы анализа/деталей: архивная тоже валидна — её данные живут дальше. */
export async function getCategoryAny(id: number): Promise<JournalCategory | null> {
  const db = getDb();
  const [row] = await db.select().from(journalCategories).where(eq(journalCategories.id, id)).limit(1);
  return row ?? null;
}

export async function createCategory(name: string): Promise<JournalCategory> {
  const db = getDb();
  const [created] = await db.insert(journalCategories).values({ name }).returning();
  if (!created) throw new Error("Не удалось создать категорию");
  return created;
}

export async function renameCategory(id: number, name: string): Promise<JournalCategory | null> {
  const db = getDb();
  const [updated] = await db
    .update(journalCategories)
    .set({ name })
    .where(and(eq(journalCategories.id, id), isNull(journalCategories.archivedAt)))
    .returning();
  return updated ?? null;
}

/**
 * Удаление категории: с разборами — архив (данные сохраняются), без — физическое
 * удаление (пункты уходят каскадом; ответов на них быть не может — ответы существуют
 * только внутри разбора этой же категории).
 */
export async function deleteOrArchiveCategory(id: number): Promise<{ archived: boolean } | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [category] = await tx
      .select()
      .from(journalCategories)
      .where(and(eq(journalCategories.id, id), isNull(journalCategories.archivedAt)))
      .limit(1);
    if (!category) return null;
    const [entriesRow] = await tx
      .select({ value: count() })
      .from(journalEntries)
      .where(eq(journalEntries.categoryId, id));
    if ((entriesRow?.value ?? 0) > 0) {
      await tx
        .update(journalCategories)
        .set({ archivedAt: new Date() })
        .where(eq(journalCategories.id, id));
      return { archived: true };
    }
    await tx.delete(journalCategories).where(eq(journalCategories.id, id));
    return { archived: false };
  });
}

// --- Пункты чек-листов -------------------------------------------------------------------

export async function listActiveItems(categoryId: number): Promise<JournalChecklistItem[]> {
  const db = getDb();
  return db
    .select()
    .from(journalChecklistItems)
    .where(and(eq(journalChecklistItems.categoryId, categoryId), isNull(journalChecklistItems.archivedAt)))
    .orderBy(asc(journalChecklistItems.sortOrder), asc(journalChecklistItems.id));
}

/** Все пункты категории (включая архивные) — для таблицы анализа и просмотра старых разборов. */
export async function listAllItems(categoryId: number): Promise<JournalChecklistItem[]> {
  const db = getDb();
  return db
    .select()
    .from(journalChecklistItems)
    .where(eq(journalChecklistItems.categoryId, categoryId))
    .orderBy(asc(journalChecklistItems.sortOrder), asc(journalChecklistItems.id));
}

export async function createItem(
  categoryId: number,
  label: string,
  answerType: AnswerType,
): Promise<JournalChecklistItem> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [orderRow] = await tx
      .select({ maxOrder: sql<number>`coalesce(max(${journalChecklistItems.sortOrder}), 0)` })
      .from(journalChecklistItems)
      .where(eq(journalChecklistItems.categoryId, categoryId));
    const [created] = await tx
      .insert(journalChecklistItems)
      .values({ categoryId, label, answerType, sortOrder: Number(orderRow?.maxOrder ?? 0) + 1 })
      .returning();
    if (!created) throw new Error("Не удалось создать пункт чек-листа");
    return created;
  });
}

export async function renameItem(id: number, label: string): Promise<JournalChecklistItem | null> {
  const db = getDb();
  const [updated] = await db
    .update(journalChecklistItems)
    .set({ label })
    .where(and(eq(journalChecklistItems.id, id), isNull(journalChecklistItems.archivedAt)))
    .returning();
  return updated ?? null;
}

/** Удаление пункта: с ответами — архив (ответы сохраняются), без — физическое удаление. */
export async function deleteOrArchiveItem(id: number): Promise<{ archived: boolean } | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(journalChecklistItems)
      .where(and(eq(journalChecklistItems.id, id), isNull(journalChecklistItems.archivedAt)))
      .limit(1);
    if (!item) return null;
    const [answersRow] = await tx
      .select({ value: count() })
      .from(journalAnswers)
      .where(eq(journalAnswers.itemId, id));
    if ((answersRow?.value ?? 0) > 0) {
      await tx
        .update(journalChecklistItems)
        .set({ archivedAt: new Date() })
        .where(eq(journalChecklistItems.id, id));
      return { archived: true };
    }
    await tx.delete(journalChecklistItems).where(eq(journalChecklistItems.id, id));
    return { archived: false };
  });
}

/**
 * Переставляет активные пункты категории в заданном порядке (drag-and-drop в конструкторе):
 * sort_order = позиция в списке. Вызывающий код обязан проверить порядок validateItemsReorder.
 */
export async function reorderItems(categoryId: number, itemIds: number[]): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    for (const [index, itemId] of itemIds.entries()) {
      await tx
        .update(journalChecklistItems)
        .set({ sortOrder: index + 1 })
        .where(
          and(
            eq(journalChecklistItems.id, itemId),
            eq(journalChecklistItems.categoryId, categoryId),
            isNull(journalChecklistItems.archivedAt),
          ),
        );
    }
  });
}

/** id пунктов, на которые есть хотя бы один ответ, — конструктору для пометки «есть данные». */
export async function itemIdsWithAnswers(itemIds: number[]): Promise<Set<number>> {
  if (itemIds.length === 0) return new Set();
  const db = getDb();
  const rows = await db
    .selectDistinct({ itemId: journalAnswers.itemId })
    .from(journalAnswers)
    .where(inArray(journalAnswers.itemId, itemIds));
  return new Set(rows.map((row) => row.itemId));
}

// --- Разборы (entries + answers) ---------------------------------------------------------

/**
 * Создаёт или полностью переписывает разбор сделки. Ответы принадлежат чек-листу
 * категории, поэтому при любом сохранении старый набор ответов заменяется новым целиком
 * (в том числе при смене категории) — атомарно, в одной транзакции.
 */
export async function upsertEntry(
  tradeId: number,
  categoryId: number,
  normalized: NormalizedAnswer[],
): Promise<JournalEntry> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(journalEntries)
      .values({ tradeId, categoryId })
      .onConflictDoUpdate({
        target: journalEntries.tradeId,
        set: { categoryId, updatedAt: new Date() },
      })
      .returning();
    if (!entry) throw new Error("Не удалось сохранить разбор");
    await tx.delete(journalAnswers).where(eq(journalAnswers.entryId, entry.id));
    if (normalized.length > 0) {
      await tx.insert(journalAnswers).values(
        normalized.map((answer) => ({
          entryId: entry.id,
          itemId: answer.itemId,
          valueBool: answer.valueBool,
          valueInt: answer.valueInt,
          valueText: answer.valueText,
        })),
      );
    }
    return entry;
  });
}

/** Убирает разбор — сделка возвращается в «неразобранные». Ответы уходят каскадом. */
export async function deleteEntry(tradeId: number): Promise<boolean> {
  const db = getDb();
  const deleted = await db
    .delete(journalEntries)
    .where(eq(journalEntries.tradeId, tradeId))
    .returning({ id: journalEntries.id });
  return deleted.length > 0;
}

export type EntryWithAnswers = {
  entry: JournalEntry;
  answers: JournalAnswerRow[];
};

export async function getEntryWithAnswers(tradeId: number): Promise<EntryWithAnswers | null> {
  const db = getDb();
  const [entry] = await db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.tradeId, tradeId))
    .limit(1);
  if (!entry) return null;
  const answers = await db.select().from(journalAnswers).where(eq(journalAnswers.entryId, entry.id));
  return { entry, answers };
}

// --- Списки сделок журнала ---------------------------------------------------------------

export type JournalTradesFilter = { kind: "unsorted" } | { kind: "all" } | { kind: "category"; categoryId: number };

export type JournalTradeRow = { trade: Trade; categoryId: number | null };

/**
 * Закрытые сделки для ленты «Разбора», сначала новые. «Неразобранные» — это отсутствие
 * строки в journal_entries, поэтому новая закрытая сделка попадает в фильтр сама.
 */
export async function listJournalTrades(
  filter: JournalTradesFilter,
  options: { limit: number; offset: number },
): Promise<{ rows: JournalTradeRow[]; total: number }> {
  const db = getDb();
  const closedOnly = eq(trades.status, "closed");
  const where =
    filter.kind === "unsorted"
      ? and(
          closedOnly,
          notExists(
            db.select({ one: sql`1` }).from(journalEntries).where(eq(journalEntries.tradeId, trades.id)),
          ),
        )
      : filter.kind === "category"
        ? and(closedOnly, eq(journalEntries.categoryId, filter.categoryId))
        : closedOnly;

  const baseQuery = db
    .select({ trade: trades, categoryId: journalEntries.categoryId })
    .from(trades)
    .leftJoin(journalEntries, eq(journalEntries.tradeId, trades.id))
    .where(where)
    .orderBy(desc(trades.closedAt))
    .limit(options.limit)
    .offset(options.offset);

  const totalQuery = db
    .select({ value: count() })
    .from(trades)
    .leftJoin(journalEntries, eq(journalEntries.tradeId, trades.id))
    .where(where);

  const [rows, [totalRow]] = await Promise.all([baseQuery, totalQuery]);
  return { rows, total: totalRow?.value ?? 0 };
}

export async function countUnsortedTrades(): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ value: count() })
    .from(trades)
    .where(
      and(
        eq(trades.status, "closed"),
        notExists(
          db.select({ one: sql`1` }).from(journalEntries).where(eq(journalEntries.tradeId, trades.id)),
        ),
      ),
    );
  return row?.value ?? 0;
}

/** Число разобранных сделок по каждой активной категории — для чипов и экрана «Анализ». */
export async function countEntriesByCategory(): Promise<Map<number, number>> {
  const db = getDb();
  const rows = await db
    .select({ categoryId: journalEntries.categoryId, value: count() })
    .from(journalEntries)
    .groupBy(journalEntries.categoryId);
  return new Map(rows.map((row) => [row.categoryId, row.value]));
}

/** Число активных пунктов по категориям — конструктору и экрану «Анализ». */
export async function countActiveItemsByCategory(): Promise<Map<number, number>> {
  const db = getDb();
  const rows = await db
    .select({ categoryId: journalChecklistItems.categoryId, value: count() })
    .from(journalChecklistItems)
    .where(isNull(journalChecklistItems.archivedAt))
    .groupBy(journalChecklistItems.categoryId);
  return new Map(rows.map((row) => [row.categoryId, row.value]));
}

export type AnalysisEntryRow = {
  trade: Trade;
  entryId: number;
  answers: JournalAnswerRow[];
};

/** Все разобранные сделки категории с ответами — данные таблицы анализа, сначала новые. */
export async function listAnalysisRows(categoryId: number): Promise<AnalysisEntryRow[]> {
  const db = getDb();
  const entryRows = await db
    .select({ trade: trades, entry: journalEntries })
    .from(journalEntries)
    .innerJoin(trades, eq(trades.id, journalEntries.tradeId))
    .where(eq(journalEntries.categoryId, categoryId))
    .orderBy(desc(trades.closedAt));
  if (entryRows.length === 0) return [];
  const entryIds = entryRows.map((row) => row.entry.id);
  const answers = await db
    .select()
    .from(journalAnswers)
    .where(inArray(journalAnswers.entryId, entryIds));
  const answersByEntry = new Map<number, JournalAnswerRow[]>();
  for (const answer of answers) {
    const list = answersByEntry.get(answer.entryId) ?? [];
    list.push(answer);
    answersByEntry.set(answer.entryId, list);
  }
  return entryRows.map((row) => ({
    trade: row.trade,
    entryId: row.entry.id,
    answers: answersByEntry.get(row.entry.id) ?? [],
  }));
}

import { boolean, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { trades } from "../db/schema.js";

/**
 * Схема журнала разбора сделок (раздел /journal — отдельная PWA «Bablo.Дневник»).
 *
 * Журнал живёт СБОКУ от торгового контура: свои таблицы с префиксом journal_*, из
 * основных данных он только ЧИТАЕТ trades. «Неразобранные» сделки нигде не хранятся —
 * это закрытые сделки без строки в journal_entries, поэтому новая закрытая сделка
 * попадает в неразобранные сама, без фоновых задач и синхронизации.
 *
 * ON DELETE CASCADE от trades: «Очистить данные для нового аккаунта» удаляет сделки —
 * их разборы уходят вместе с ними. Категории и чек-листы остаются: это настройки
 * пользователя, а не данные аккаунта (как лестница уровней или активы).
 */

/** Категория разбора (тип сетапа/входа — таксономию задаёт пользователь). */
export const journalCategories = pgTable("journal_categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  /**
   * Архив вместо удаления, когда по категории уже есть разборы: удалить её физически
   * значило бы потерять ответы. Заархивированная не предлагается при разборе и не видна
   * в конструкторе, но её сделки продолжают показывать категорию и ответы.
   */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Пункт чек-листа категории. Тип ответа фиксируется при создании и не меняется. */
export const journalChecklistItems = pgTable("journal_checklist_items", {
  id: serial("id").primaryKey(),
  categoryId: integer("category_id")
    .notNull()
    .references(() => journalCategories.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  /** 'yes_no' | 'scale_0_10' | 'text' — см. journal/logic.ts (ANSWER_TYPES). */
  answerType: text("answer_type").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  /**
   * Архив вместо удаления, когда на пункт уже отвечали: старые ответы сохраняются и
   * видны в разборе и в таблице анализа (колонка помечается архивной), но у новых
   * разборов пункт больше не спрашивается.
   */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Разбор сделки: сделка отнесена ровно в одну категорию (UNIQUE trade_id — решение
 * пользователя от 23.09.2026). Смена категории переписывает разбор целиком: ответы
 * принадлежат чек-листу категории и на другой не переносятся.
 */
export const journalEntries = pgTable("journal_entries", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id")
    .notNull()
    .unique()
    .references(() => trades.id, { onDelete: "cascade" }),
  // Без onDelete: БД не даст физически удалить категорию, у которой есть разборы, —
  // сервис в этом случае архивирует (см. repository.deleteOrArchiveCategory).
  categoryId: integer("category_id")
    .notNull()
    .references(() => journalCategories.id),
  categorizedAt: timestamp("categorized_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Ответ на пункт чек-листа. Значение — в колонке своего типа (ровно одна не-null,
 * по answerType пункта): типизированные колонки вместо jsonb, чтобы агрегаты таблицы
 * анализа (доля «да», среднее по шкале) считались без парсинга.
 */
export const journalAnswers = pgTable(
  "journal_answers",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    itemId: integer("item_id")
      .notNull()
      .references(() => journalChecklistItems.id, { onDelete: "cascade" }),
    valueBool: boolean("value_bool"),
    valueInt: integer("value_int"),
    valueText: text("value_text"),
  },
  (t) => [uniqueIndex("journal_answers_entry_item_idx").on(t.entryId, t.itemId)],
);

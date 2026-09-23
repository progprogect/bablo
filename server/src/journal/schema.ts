import { boolean, integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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

/**
 * Свечи BingX для графика сделки (журнал). Ключ — (symbol, interval, open_time):
 * свечи переиспользуются между сделками одного символа, дозагрузка идемпотентна
 * (ON CONFLICT DO NOTHING). Источник — публичный market-data эндпоинт klines,
 * ключи BingX не нужны. Закрытая сделка «замораживает» свой период: свечи прошлого
 * не меняются, поэтому кэш вечный и график не зависит от глубины истории биржи.
 */
export const journalCandles = pgTable(
  "journal_candles",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    /** "15m" | "1h" (JOURNAL_CANDLE_INTERVALS в journal/marketData.ts). */
    interval: text("interval").notNull(),
    openTime: timestamp("open_time", { withTimezone: true }).notNull(),
    open: numeric("open", { precision: 20, scale: 8 }).notNull(),
    high: numeric("high", { precision: 20, scale: 8 }).notNull(),
    low: numeric("low", { precision: 20, scale: 8 }).notNull(),
    close: numeric("close", { precision: 20, scale: 8 }).notNull(),
    volume: numeric("volume", { precision: 24, scale: 8 }),
  },
  (t) => [uniqueIndex("journal_candles_key_idx").on(t.symbol, t.interval, t.openTime)],
);

/**
 * Факт «окно свечей для сделки собрано» — по одному на (trade, interval). Без него
 * каждый показ графика заново ходил бы к бирже, а бэкфилл не знал бы, что уже готово.
 */
export const journalCandleSyncs = pgTable(
  "journal_candle_syncs",
  {
    id: serial("id").primaryKey(),
    tradeId: integer("trade_id")
      .notNull()
      .references(() => trades.id, { onDelete: "cascade" }),
    interval: text("interval").notNull(),
    fromTime: timestamp("from_time", { withTimezone: true }).notNull(),
    toTime: timestamp("to_time", { withTimezone: true }).notNull(),
    /** Сколько свечей реально пришло: 0 — у биржи не осталось истории на этот период. */
    candlesFetched: integer("candles_fetched").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("journal_candle_syncs_key_idx").on(t.tradeId, t.interval)],
);

/**
 * Снапшот индикаторов и производных сделки для будущего анализа (в UI не выводится —
 * решение пользователя от 23.09.2026). Считается из свечей чистыми функциями
 * (journal/indicators.ts) при сборе данных; version — версия формулы расчёта, чтобы
 * при её изменении пересчитать старые снапшоты, не гадая, чем они считались.
 */
export const journalTradeMetrics = pgTable("journal_trade_metrics", {
  tradeId: integer("trade_id")
    .primaryKey()
    .references(() => trades.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb("payload").notNull(),
});

/**
 * Линии, нарисованные пользователем на графике сделки (рабочая зона). Координаты —
 * (time ms, цена), поэтому не зависят от таймфрейма и зума. Один jsonb-массив на
 * сделку: пользователь один, PUT перезаписывает целиком.
 */
export const journalChartDrawings = pgTable("journal_chart_drawings", {
  tradeId: integer("trade_id")
    .primaryKey()
    .references(() => trades.id, { onDelete: "cascade" }),
  drawings: jsonb("drawings").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

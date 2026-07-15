import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** Key/value конфигурация: BingX-ключи (зашифрованы), PIN-хэш, таймзона сброса дня и т.д. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Торгуемые активы, отображаемые табами на дашборде. */
export const assets = pgTable("assets", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().unique(),
  leverage: integer("leverage").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
});

/** Редактируемая лестница уровней риска (см. docs/RISK_ENGINE.md). */
export const riskLevels = pgTable("risk_levels", {
  id: serial("id").primaryKey(),
  level: integer("level").notNull().unique(),
  riskUsd: numeric("risk_usd", { precision: 10, scale: 2 }).notNull(),
  requiredR: numeric("required_r", { precision: 10, scale: 2 }).notNull(),
});

/** Текущее состояние прогресса риск-плана (singleton — одна строка). */
export const riskState = pgTable("risk_state", {
  id: serial("id").primaryKey(),
  currentLevel: integer("current_level").notNull().default(1),
  accumulatedR: numeric("accumulated_r", { precision: 10, scale: 4 }).notNull().default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Активные блокировки открытия сделки (кулдаун, дневные лимиты). */
export const riskLocks = pgTable("risk_locks", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  reason: text("reason").notNull(),
  until: timestamp("until", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Сделки: от открытия до расширенного трекинга для статистики. */
export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(), // 'long' | 'short'
  status: text("status").notNull().default("active"), // 'active' | 'closed'
  quantity: numeric("quantity", { precision: 20, scale: 8 }).notNull(),
  leverage: integer("leverage").notNull(),
  entryPrice: numeric("entry_price", { precision: 20, scale: 8 }),
  slPrice: numeric("sl_price", { precision: 20, scale: 8 }),
  tpPrice: numeric("tp_price", { precision: 20, scale: 8 }),
  rrPreset: text("rr_preset"),
  riskUsd: numeric("risk_usd", { precision: 10, scale: 2 }),
  // Частичная фиксация: опциональный доп. TP на часть объёма (см. docs/PROJECT.md).
  // Не заменяет основной tpPrice — основной ордер выставляется на остаток объёма.
  partialTpPrice: numeric("partial_tp_price", { precision: 20, scale: 8 }),
  partialTpPercent: numeric("partial_tp_percent", { precision: 5, scale: 2 }),
  partialTpQuantity: numeric("partial_tp_quantity", { precision: 20, scale: 8 }),
  partialTpFilledAt: timestamp("partial_tp_filled_at", { withTimezone: true }),
  partialTpFillPrice: numeric("partial_tp_fill_price", { precision: 20, scale: 8 }),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closeReason: text("close_reason"), // 'sl' | 'tp' | 'manual' | 'external' (закрыта на бирже, обнаружено постфактум)
  closePrice: numeric("close_price", { precision: 20, scale: 8 }),
  resultR: numeric("result_r", { precision: 10, scale: 4 }),
  resultPct: numeric("result_pct", { precision: 10, scale: 4 }),
  mfePrice: numeric("mfe_price", { precision: 20, scale: 8 }),
  beCrossed: boolean("be_crossed").notNull().default(false),
  bingxOrderIds: jsonb("bingx_order_ids"),
  signals: jsonb("signals"),
});

/** Дневные агрегаты для быстрой проверки лимитов риск-плана без пересчёта истории. */
export const dailyStats = pgTable("daily_stats", {
  date: date("date").primaryKey(),
  sumR: numeric("sum_r", { precision: 10, scale: 4 }).notNull().default("0"),
  tradesCount: integer("trades_count").notNull().default(0),
});

/**
 * Снимок эквити на календарный день (локальная таймзона, docs/RISK_ENGINE.md). Один
 * снимок в день, лениво создаётся при первой загрузке дашборда за день (best-effort,
 * без поллинга). Используется как база для "% к депозиту" в месячной статистике —
 * истории баланса до появления этой таблицы не существует, поэтому для месяцев без
 * снимков % не считается (см. history/monthlyStats.ts).
 */
export const equitySnapshots = pgTable("equity_snapshots", {
  date: date("date").primaryKey(),
  equity: numeric("equity", { precision: 20, scale: 8 }).notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Ручные пополнения/выводы средств на BingX-аккаунте — не связаны с результатом торговли,
 * поэтому не отражены в trades.resultR. Нужны, чтобы корректно восстанавливать баланс на
 * начало прошлых месяцев "в обратную сторону" от последнего известного снимка эквити
 * (см. history/monthlyStats.ts): equity(месяц назад) = текущий эквити − PnL сделок за
 * период − сумма пополнений/выводов за тот же период (знак amountUsd: + пополнение,
 * − вывод).
 */
export const equityAdjustments = pgTable("equity_adjustments", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  amountUsd: numeric("amount_usd", { precision: 20, scale: 8 }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

-- Журнал разбора сделок (раздел /journal, отдельная PWA «Bablo.Дневник», 23.09.2026).
-- Четыре свои таблицы сбоку от торгового контура; из основных данных журнал только
-- читает trades. «Неразобранные» сделки не хранятся — это закрытые сделки без строки
-- в journal_entries. Подробности — server/src/journal/schema.ts и docs/ARCHITECTURE.md.
CREATE TABLE IF NOT EXISTS "journal_categories" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "journal_checklist_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "category_id" integer NOT NULL REFERENCES "journal_categories"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "answer_type" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "journal_entries" (
  "id" serial PRIMARY KEY NOT NULL,
  "trade_id" integer NOT NULL UNIQUE REFERENCES "trades"("id") ON DELETE CASCADE,
  "category_id" integer NOT NULL REFERENCES "journal_categories"("id"),
  "categorized_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "journal_answers" (
  "id" serial PRIMARY KEY NOT NULL,
  "entry_id" integer NOT NULL REFERENCES "journal_entries"("id") ON DELETE CASCADE,
  "item_id" integer NOT NULL REFERENCES "journal_checklist_items"("id") ON DELETE CASCADE,
  "value_bool" boolean,
  "value_int" integer,
  "value_text" text
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "journal_answers_entry_item_idx"
  ON "journal_answers" ("entry_id", "item_id");

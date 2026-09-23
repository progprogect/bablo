-- График сделки в журнале (23.09.2026): кэш свечей BingX, факт сбора окна по сделке,
-- снапшот индикаторов для будущего анализа (в UI не выводится) и линии пользователя
-- на графике. Подробности — server/src/journal/schema.ts, docs/ARCHITECTURE.md.
CREATE TABLE IF NOT EXISTS "journal_candles" (
  "id" serial PRIMARY KEY NOT NULL,
  "symbol" text NOT NULL,
  "interval" text NOT NULL,
  "open_time" timestamp with time zone NOT NULL,
  "open" numeric(20, 8) NOT NULL,
  "high" numeric(20, 8) NOT NULL,
  "low" numeric(20, 8) NOT NULL,
  "close" numeric(20, 8) NOT NULL,
  "volume" numeric(24, 8)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "journal_candles_key_idx"
  ON "journal_candles" ("symbol", "interval", "open_time");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "journal_candle_syncs" (
  "id" serial PRIMARY KEY NOT NULL,
  "trade_id" integer NOT NULL REFERENCES "trades"("id") ON DELETE CASCADE,
  "interval" text NOT NULL,
  "from_time" timestamp with time zone NOT NULL,
  "to_time" timestamp with time zone NOT NULL,
  "candles_fetched" integer NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "journal_candle_syncs_key_idx"
  ON "journal_candle_syncs" ("trade_id", "interval");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "journal_trade_metrics" (
  "trade_id" integer PRIMARY KEY REFERENCES "trades"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "payload" jsonb NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "journal_chart_drawings" (
  "trade_id" integer PRIMARY KEY REFERENCES "trades"("id") ON DELETE CASCADE,
  "drawings" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

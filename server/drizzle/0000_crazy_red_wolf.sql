CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"leverage" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "assets_symbol_unique" UNIQUE("symbol")
);
--> statement-breakpoint
CREATE TABLE "daily_stats" (
	"date" date PRIMARY KEY NOT NULL,
	"sum_r" numeric(10, 4) DEFAULT '0' NOT NULL,
	"trades_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_levels" (
	"id" serial PRIMARY KEY NOT NULL,
	"level" integer NOT NULL,
	"risk_usd" numeric(10, 2) NOT NULL,
	"required_r" numeric(10, 2) NOT NULL,
	CONSTRAINT "risk_levels_level_unique" UNIQUE("level")
);
--> statement-breakpoint
CREATE TABLE "risk_locks" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"reason" text NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"current_level" integer DEFAULT 1 NOT NULL,
	"accumulated_r" numeric(10, 4) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"quantity" numeric(20, 8) NOT NULL,
	"leverage" integer NOT NULL,
	"entry_price" numeric(20, 8),
	"sl_price" numeric(20, 8),
	"tp_price" numeric(20, 8),
	"rr_preset" text,
	"risk_usd" numeric(10, 2),
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"close_price" numeric(20, 8),
	"result_r" numeric(10, 4),
	"result_pct" numeric(10, 4),
	"mfe_price" numeric(20, 8),
	"be_crossed" boolean DEFAULT false NOT NULL,
	"bingx_order_ids" jsonb,
	"signals" jsonb
);

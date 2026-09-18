CREATE TABLE IF NOT EXISTS "level_withdrawals" (
	"id" serial PRIMARY KEY NOT NULL,
	"level" integer NOT NULL,
	"required_usd" numeric(20, 8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_usd" numeric(20, 8),
	"withdrawn_at" timestamp with time zone,
	"source" text,
	"external_id" text,
	"equity_adjustment_id" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "level_withdrawals_external_id_idx" ON "level_withdrawals" ("external_id") WHERE "external_id" IS NOT NULL;

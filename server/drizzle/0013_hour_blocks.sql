CREATE TABLE IF NOT EXISTS "hour_blocks" (
	"id" serial PRIMARY KEY NOT NULL,
	"hour" integer NOT NULL,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unblocked_at" timestamp with time zone,
	"trades_at_block" integer NOT NULL,
	"tp_at_block" integer NOT NULL,
	"reference_at_block" integer NOT NULL,
	"reference_at_unblock" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hour_blocks_active_hour_idx" ON "hour_blocks" ("hour") WHERE "unblocked_at" IS NULL;

ALTER TABLE "daily_stats" ADD COLUMN "tp_count" integer DEFAULT 0 NOT NULL;-->statement-breakpoint
ALTER TABLE "daily_stats" ADD COLUMN "strong_recovery_after_sl" boolean DEFAULT false NOT NULL;

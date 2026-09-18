ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS "tp_price_initial" numeric(20, 8);
--> statement-breakpoint
UPDATE "trades" SET "tp_price_initial" = "tp_price" WHERE "tp_price_initial" IS NULL AND "tp_price" IS NOT NULL;

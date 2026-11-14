ALTER TABLE "assets" ADD COLUMN "min_stop_pct" double precision;--> statement-breakpoint
UPDATE "assets" SET "min_stop_pct" = 0.7 WHERE "symbol" = 'WLD-USDT';--> statement-breakpoint
UPDATE "assets" SET "min_stop_pct" = 0.65 WHERE "symbol" = 'VIRTUAL-USDT';--> statement-breakpoint
UPDATE "assets" SET "min_stop_pct" = 0.5 WHERE "symbol" = 'TIA-USDT';--> statement-breakpoint
UPDATE "assets" SET "min_stop_pct" = 0.55 WHERE "symbol" = 'TAO-USDT';

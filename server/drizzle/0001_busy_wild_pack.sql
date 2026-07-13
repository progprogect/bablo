ALTER TABLE "trades" ADD COLUMN "partial_tp_price" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "partial_tp_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "partial_tp_quantity" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "partial_tp_filled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "partial_tp_fill_price" numeric(20, 8);
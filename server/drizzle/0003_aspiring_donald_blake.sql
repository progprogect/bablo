CREATE TABLE "equity_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"amount_usd" numeric(20, 8) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

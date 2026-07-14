CREATE TABLE "equity_snapshots" (
	"date" date PRIMARY KEY NOT NULL,
	"equity" numeric(20, 8) NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);

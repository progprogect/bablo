-- Ручные блокировки торговли (запрос пользователя от 01.10.2026). Правило убыточных
-- часов (авто-расчёт с эталоном, гистерезис, проверки винрейта) удалено из кода целиком:
-- блокировки теперь ставит только пользователь в настройках («История» → «Настройки»),
-- всегда со сроком, и до истечения срока снять их нельзя.
CREATE TABLE IF NOT EXISTS "manual_trading_blocks" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"hour" integer,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Таблица hour_blocks остаётся замороженной историей удалённого правила (данные о том,
-- когда и почему часы закрывались, терять нельзя), но активных блокировок в ней больше
-- не должно быть: механизмов, которые их снимали, в коде нет. Часы, закрытые на момент
-- деплоя (9 и 10), этим открываются — при желании они закрываются заново уже в новых
-- настройках, со сроком.
UPDATE "hour_blocks" SET "unblocked_at" = now() WHERE "unblocked_at" IS NULL;

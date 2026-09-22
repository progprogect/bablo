-- Ручная блокировка часа с разовой проверкой по месячному винрейту (запрос пользователя
-- от 22.09.2026, docs/RISK_ENGINE.md правило #10). Авто-блокировки снимаются гистерезисом
-- «эталон ×1.5», ручные — только сравнением винрейта двух месяцев, поэтому происхождение
-- блокировки и параметры проверки хранятся прямо в строке.
ALTER TABLE "hour_blocks" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "hour_blocks" ADD COLUMN IF NOT EXISTS "review_baseline_month" text;--> statement-breakpoint
ALTER TABLE "hour_blocks" ADD COLUMN IF NOT EXISTS "review_from_month" text;--> statement-breakpoint
ALTER TABLE "hour_blocks" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;--> statement-breakpoint

-- Закрываем 9:00 и 10:00 (таймзона риск-плана, по умолчанию UTC+3 = МСК). Проверка —
-- по итогам первого завершённого месяца начиная с октября 2026, в котором есть закрытые
-- сделки; база сравнения — сентябрь 2026.
--
-- Шаг 1: час уже может быть закрыт авто-правилом. Тогда новую строку завести нельзя
-- (частичный уникальный индекс на активный час), да и не нужно — достаточно перевести
-- существующую блокировку в ручную. Иначе она осталась бы авто и открылась бы
-- гистерезисом, то есть запрос пользователя молча не выполнился бы.
UPDATE "hour_blocks"
SET "source" = 'manual',
    "review_baseline_month" = '2026-09',
    "review_from_month" = '2026-10',
    "reviewed_at" = NULL
WHERE "hour" IN (9, 10) AND "unblocked_at" IS NULL;--> statement-breakpoint

-- Шаг 2: часы, которые сейчас открыты, закрываем новой строкой. Снимки статистики на
-- момент блокировки у ручных смысла не имеют (час закрыт решением, а не расчётом) — нули.
INSERT INTO "hour_blocks"
  ("hour", "trades_at_block", "tp_at_block", "reference_at_block",
   "source", "review_baseline_month", "review_from_month")
SELECT h, 0, 0, 0, 'manual', '2026-09', '2026-10'
FROM (VALUES (9), (10)) AS t(h)
WHERE NOT EXISTS (
  SELECT 1 FROM "hour_blocks" b WHERE b."hour" = t.h AND b."unblocked_at" IS NULL
);

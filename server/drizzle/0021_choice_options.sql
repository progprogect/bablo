-- Тип ответа «выбор одного из вариантов» в чек-листах журнала (23.09.2026):
-- варианты пункта задаются при создании и хранятся jsonb-массивом строк; сам ответ
-- ложится в существующую value_text. Колонка нужна только пунктам answer_type='choice'.
ALTER TABLE "journal_checklist_items" ADD COLUMN IF NOT EXISTS "options" jsonb;

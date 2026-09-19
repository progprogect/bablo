-- Сумма обязательного вывода выросла с 1R до 2R пройденного уровня, а с 22-го уровня —
-- до 3R (решение пользователя от 19.09.2026). Пересчитываем ещё НЕ выполненные
-- требования, чтобы они не остались со старой суммой; история сделанных выводов не
-- трогается.
UPDATE "level_withdrawals" AS lw
SET "required_usd" = rl."risk_usd" * (CASE WHEN lw."level" >= 22 THEN 3 ELSE 2 END)
FROM "risk_levels" AS rl
WHERE rl."level" = lw."level" AND lw."withdrawn_at" IS NULL;

-- Расширение лестницы уровней (31.08.2026): мелкий шаг выше 100 USDT + единые +5R.
--
-- Сид risk_levels срабатывает только на ПУСТОЙ таблице, поэтому на боевой БД (уровни 1–26)
-- новая лестница не появилась бы сама. Здесь номера уровней переиспользуются под новые
-- суммы риска, из-за чего один и тот же номер начинает означать другой риск: сохраняем
-- фактический риск текущего уровня ДО перестройки и после неё возвращаем пользователя на
-- ступень с тем же риском (или ближайшую не выше). Иначе прогресс молча уехал бы на
-- другой размер позиции — это реальные деньги.
DO $$
DECLARE
  prev_risk_usd numeric;
  remapped_level integer;
BEGIN
  SELECT rl.risk_usd
    INTO prev_risk_usd
    FROM risk_state rs
    JOIN risk_levels rl ON rl.level = rs.current_level
    ORDER BY rs.id
    LIMIT 1;

  INSERT INTO risk_levels (level, risk_usd, required_r) VALUES
      (1, 10, 5), (2, 20, 5), (3, 30, 5), (4, 40, 5), (5, 50, 5), (6, 60, 5),
      (7, 70, 5), (8, 80, 5), (9, 90, 5), (10, 100, 5), (11, 120, 5), (12, 140, 5),
      (13, 150, 5), (14, 160, 5), (15, 180, 5), (16, 200, 5), (17, 220, 5), (18, 240, 5),
      (19, 250, 5), (20, 260, 5), (21, 280, 5), (22, 300, 5), (23, 320, 5), (24, 340, 5),
      (25, 350, 5), (26, 360, 5), (27, 380, 5), (28, 400, 5), (29, 420, 5), (30, 440, 5),
      (31, 450, 5), (32, 460, 5), (33, 480, 5), (34, 500, 5), (35, 520, 5), (36, 550, 5),
      (37, 570, 5), (38, 600, 5), (39, 620, 5), (40, 650, 5), (41, 670, 5), (42, 700, 5),
      (43, 720, 5), (44, 750, 5), (45, 770, 5), (46, 800, 5), (47, 850, 5), (48, 900, 5),
      (49, 950, 5), (50, 1000, 100)
  ON CONFLICT (level) DO UPDATE
    SET risk_usd = EXCLUDED.risk_usd,
        required_r = EXCLUDED.required_r;

  IF prev_risk_usd IS NOT NULL THEN
    SELECT level
      INTO remapped_level
      FROM risk_levels
      WHERE risk_usd <= prev_risk_usd
      ORDER BY risk_usd DESC, level DESC
      LIMIT 1;

    IF remapped_level IS NOT NULL THEN
      UPDATE risk_state SET current_level = remapped_level, updated_at = now();
    END IF;
  END IF;
END $$;

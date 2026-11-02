/**
 * Стартовая статистика по часам (просьба пользователя от 02.11.2026).
 *
 * После потери базы на Railway история сделок не вернулась, но пользователь помнит свою
 * статистику по часам: «11 - 16/32» — в одиннадцать часов было 32 входа, 16 из них
 * закончились тейком. Эти цифры кладутся отдельным слоем и складываются с реальными
 * сделками ТОЛЬКО в гистограмме «Тейки по часам открытия».
 *
 * Почему не выдуманные сделки в trades: синтетика исказила бы месячную статистику, суммы
 * R, прогресс уровней и список сделок — всё то, чего пользователь не просил трогать.
 *
 * Здесь только чистые функции: разбор текста и сложение. Таблица и API — рядом.
 */

export type HourBaselineEntry = {
  /** Час суток 0–23 в таймзоне риск-плана. */
  hour: number;
  /** Сколько сделок открыто в этот час. */
  total: number;
  /** Сколько из них закончились тейком. */
  tpCount: number;
};

export type ParsedHourBaseline = {
  entries: HourBaselineEntry[];
  /** Строки, которые разобрать не удалось, — показываем их пользователю как есть. */
  errors: string[];
};

/**
 * Разбирает список вида «11 - 16/32», по строке на час. Пользователь вставляет его
 * целиком, поэтому формат нарочно терпимый: допускаются «6- 1/1», ведущий ноль («00»),
 * любые хвосты вроде «примерно», пустые строки.
 *
 * Повтор часа — побеждает последняя строка: так проще править вставленный список, не
 * вычищая предыдущие попытки.
 */
export function parseHourBaseline(text: string): ParsedHourBaseline {
  const byHour = new Map<number, HourBaselineEntry>();
  const errors: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;

    const match = /^(\d{1,2})\s*[-–—:.]?\s*(\d+)\s*\/\s*(\d+)/.exec(line);
    if (!match) {
      errors.push(line);
      continue;
    }

    const hour = Number(match[1]);
    const tpCount = Number(match[2]);
    const total = Number(match[3]);

    if (hour > 23) {
      errors.push(`${line} — часа ${hour} не бывает`);
      continue;
    }
    if (tpCount > total) {
      errors.push(`${line} — тейков больше, чем сделок`);
      continue;
    }
    byHour.set(hour, { hour, total, tpCount });
  }

  return {
    entries: [...byHour.values()].sort((a, b) => a.hour - b.hour),
    errors,
  };
}

/** Итоги стартовой статистики — подпись под таблицей в админке. */
export function sumBaseline(entries: HourBaselineEntry[]): { total: number; tpCount: number } {
  return entries.reduce(
    (acc, entry) => ({ total: acc.total + entry.total, tpCount: acc.tpCount + entry.tpCount }),
    { total: 0, tpCount: 0 },
  );
}

/**
 * Складывает стартовую статистику с посчитанной по реальным сделкам. Час, которого нет
 * ни там, ни там, в результат не попадает — гистограмма сама дорисует пустые часы.
 */
export function mergeHourStats(
  computed: { hour: number; total: number; tpCount: number }[],
  baseline: HourBaselineEntry[],
): { hour: number; total: number; tpCount: number }[] {
  const byHour = new Map<number, { hour: number; total: number; tpCount: number }>();
  for (const source of [baseline, computed]) {
    for (const entry of source) {
      const known = byHour.get(entry.hour);
      if (known) {
        known.total += entry.total;
        known.tpCount += entry.tpCount;
      } else {
        byHour.set(entry.hour, { ...entry });
      }
    }
  }
  return [...byHour.values()]
    .filter((entry) => entry.total > 0)
    .sort((a, b) => a.hour - b.hour);
}

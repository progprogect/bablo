/**
 * Разовая проверка ручной блокировки часа по месячному винрейту (запрос пользователя от
 * 22.09.2026). Дополняет правило убыточных часов (hourBlocks.ts), но живёт отдельно:
 * у авто- и ручных блокировок разные условия снятия, и смешивать их в одной функции
 * значило бы ветвить каждое решение.
 *
 * Смысл: час закрывается решением пользователя («кажется, утро портит статистику»), и
 * гипотеза проверяется цифрой, а не ощущением — винрейтом целого месяца, прожитого БЕЗ
 * этого часа, против месяца-базы.
 *
 * - Винрейт берётся тот же, что показывает карточка месяца в «Статистике»
 *   (`MonthlyStat.winRate` — доля сделок с результатом > 0). Решение принимается ровно по
 *   той цифре, которую пользователь видит глазами: считать «по-своему» здесь означало бы,
 *   что на экране одно, а движок решил по другому.
 * - Проверка РАЗОВАЯ (решение от 22.09.2026): подтвердилась гипотеза — час закрыт
 *   бессрочно (`reviewedAt`), и сравнение больше не повторяется.
 * - Месяц без закрытых сделок проверку не запускает, а переносит её на следующий: ноль
 *   сделок дал бы винрейт 0% и снял блокировку без единого основания. База сравнения при
 *   переносе не смещается — сравнивать с пустым месяцем так же бессмысленно.
 * - Не с чем сравнивать (нет базы) — час остаётся закрытым. Автоматически открыть его
 *   может только состоявшаяся проверка; «не смогли проверить» никогда не значит «открыть».
 */

/** Значение `hour_blocks.source` для блокировок, поставленных решением пользователя. */
export const MANUAL_HOUR_BLOCK_SOURCE = "manual";

/** Порог сравнения винрейтов — чтобы «выше» не срабатывало на шуме float. */
const WINRATE_EPSILON = 1e-9;

/** Винрейт месяца ровно в том виде, в каком его показывает карточка «Статистики». */
export type MonthWinrate = {
  year: number;
  month: number; // 1–12
  totalTrades: number;
  /** 0..1, MonthlyStat.winRate. */
  winRate: number;
};

/** Активная ручная блокировка часа и параметры её проверки. */
export type ManualHourBlockState = {
  hour: number;
  /** Месяц-база, "YYYY-MM". null — проверять не с чем, час остаётся закрытым. */
  baselineMonth: string | null;
  /** С какого месяца ("YYYY-MM") искать завершённый месяц для проверки. */
  fromMonth: string | null;
  /** Проверка уже состоялась и час закрыт бессрочно — больше ничего не делаем. */
  reviewed: boolean;
};

export type ManualHourReviewDecision = {
  /** Гипотеза не подтвердилась (винрейт не вырос) — час открыть. */
  toUnblock: number[];
  /** Гипотеза подтвердилась — час остаётся закрытым, проверка помечается выполненной. */
  toMarkReviewed: number[];
};

export type ManualHourReviewInput = {
  blocks: ManualHourBlockState[];
  /** Месячная статистика; порядок не важен, месяцы без сделок можно не передавать. */
  months: MonthWinrate[];
  now: Date;
  tzOffsetMinutes: number;
};

/** Ключ месяца "YYYY-MM" — строки этого вида корректно сравниваются лексикографически. */
export function monthKeyOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Текущий месяц в таймзоне риск-плана: границу месяца задаёт она, а не UTC и не устройство. */
export function localMonthKey(now: Date, tzOffsetMinutes: number): string {
  const shifted = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  return monthKeyOf(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1);
}

/**
 * Первый ЗАВЕРШЁННЫЙ месяц начиная с `fromMonth`, в котором есть закрытые сделки.
 * Текущий месяц не годится: он ещё идёт, его винрейт не итоговый.
 */
function findReviewMonth(
  months: MonthWinrate[],
  fromMonth: string,
  currentMonth: string,
): MonthWinrate | null {
  let found: { key: string; month: MonthWinrate } | null = null;
  for (const month of months) {
    if (month.totalTrades <= 0) continue;
    const key = monthKeyOf(month.year, month.month);
    if (key < fromMonth || key >= currentMonth) continue;
    if (found === null || key < found.key) {
      found = { key, month };
    }
  }
  return found?.month ?? null;
}

/**
 * Решение по всем ручным блокировкам. Чистая функция: состояние приходит параметром,
 * запись в БД — снаружи (hourBlocksService.ts). Идемпотентна — повторный вызов на тех же
 * данных даёт тот же ответ, а уже проверенные блокировки в решение не попадают.
 */
export function decideManualHourReview(input: ManualHourReviewInput): ManualHourReviewDecision {
  const { blocks, months, now, tzOffsetMinutes } = input;
  const currentMonth = localMonthKey(now, tzOffsetMinutes);

  const toUnblock: number[] = [];
  const toMarkReviewed: number[] = [];

  for (const block of blocks) {
    if (block.reviewed) continue;
    if (!block.baselineMonth || !block.fromMonth) continue;

    const baseline = months.find(
      (month) => monthKeyOf(month.year, month.month) === block.baselineMonth,
    );
    // Базы нет или она пустая — сравнивать не с чем, час остаётся закрытым.
    if (!baseline || baseline.totalTrades <= 0) continue;

    const review = findReviewMonth(months, block.fromMonth, currentMonth);
    // Подходящий месяц ещё не наступил (или прошёл без сделок) — ждём следующего.
    if (!review) continue;

    if (review.winRate > baseline.winRate + WINRATE_EPSILON) {
      toMarkReviewed.push(block.hour);
    } else {
      toUnblock.push(block.hour);
    }
  }

  return { toUnblock, toMarkReviewed };
}

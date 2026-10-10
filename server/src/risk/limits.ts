import type { TradeOutcome } from "../history/outcome.js";
import { getNextResetAt } from "./tradingDay.js";

export type BlockType =
  | "cooldown"
  /**
   * Ручная блокировка торговли (risk/manualBlocks.ts): закрытый час суток или
   * запланированное окно. Единственный тип, который НЕ хранится в risk_locks: часы
   * повторяются каждый день, окна заданы наперёд — лок выводится из состояния
   * manual_trading_blocks + текущего времени на лету (risk/manualBlocksService.ts).
   */
  | "manual_block"
  /**
   * Добровольная пауза «поберечь депозит» — единственный лок, который пользователь ставит
   * себе сам кнопкой на дашборде (раньше — ответом на поп-ап про состояние, убран
   * 20.09.2026). Хранится в risk_locks и НЕ входит в MANAGED_TYPES, чтобы пересборка
   * дневных локов его не стирала.
   */
  | "voluntary_pause"
  | "daily_loss"
  | "daily_profit"
  | "daily_stop_losses"
  /**
   * Лестница пауз после стопов (risk/stopChain.ts): закрывает торговлю на ПОЛНЫЕ дни
   * сверх текущего. Первое срабатывание (два стопа за день) сюда не попадает — оно
   * закрывает день обычным daily_stop_losses.
   */
  | "stop_chain"
  | "daily_take_profits"
  /** За день закрыт тейк ≥ 2R — достаточный результат сам по себе (правило #6). */
  | "daily_strong_tp"
  /** За день есть и тейк, и стоп — смешанный день закрыт (правило #15). */
  | "daily_mixed_outcomes"
  | "asset_sl_today";

/** Глобальные блокировки — скрывают форму открытия целиком. */
export type GlobalBlockType = Exclude<BlockType, "asset_sl_today">;

export type Block = {
  type: BlockType;
  /**
   * Причина для плашки на дашборде. Коротко — две строки на iPhone максимум: под причиной
   * идёт крупный таймер, поэтому «торговля возобновится после сброса дня» дописывать не
   * надо, на этот вопрос отвечает он (правка 02.10.2026 по просьбе пользователя).
   */
  reason: string;
  until: Date;
  /** Только для asset_sl_today — символ, по которому сегодня уже был стоп. */
  symbol?: string;
};

export function isGlobalBlock(block: { type: string }): boolean {
  return block.type !== "asset_sl_today";
}

/** Короткое имя актива для UI: TIA-USDT → TIA. */
export function displaySymbol(symbol: string): string {
  return symbol.replace(/-USDT$/, "");
}

export type RiskLimitsConfig = {
  cooldownMinutes: number;
  /** Отрицательное число, например -2. */
  dailyLossLimitR: number;
  /** Положительное число, например 3. */
  dailyProfitLimitR: number;
  resetHour: number;
  tzOffsetMinutes: number;
};

export type DailyLimitCounters = {
  sumR: number;
  slCount: number;
  tpCount: number;
  /** За день закрыт тейк с результатом ≥ STRONG_TP_MIN_R. */
  strongTakeProfit: boolean;
};

/**
 * Сколько сделок за день, закрытых по стопу, блокируют торговлю до следующего дня —
 * независимо от суммы R и от того, шли эти сделки подряд или нет.
 */
export const DAILY_STOP_LOSS_LIMIT = 2;

/**
 * Дни недели, в которые хватает ОДНОГО стопа, чтобы закрыть день (правило #16, запрос
 * пользователя от 10.10.2026): понедельник и пятница. Края недели — худшее время для
 * «отыграться»: в понедельник рынок ещё не показал характер недели, в пятницу решения
 * портит фиксация позиций перед выходными.
 *
 * Ключ — номер дня как у Date#getUTCDay (1 — ПН, 5 — ПТ), значение — название для текста
 * блокировки в винительном падеже («стоп в понедельник»). Один словарь, а не список
 * отдельно от подписей: добавить день = добавить строку, рассинхрону взяться негде.
 */
const SINGLE_STOP_WEEKDAYS: Record<number, string> = { 1: "понедельник", 5: "пятницу" };

/** Сколько стопов закрывают такой день. */
export const SINGLE_STOP_WEEKDAY_LIMIT = 1;

/**
 * День недели ТОРГОВОГО дня по его ключу (YYYY-MM-DD, см. risk/tradingDay.ts): 0 — вс,
 * 1 — пн … 6 — сб. Ключ уже в локальной таймзоне и сдвинут на час сброса, поэтому сделка,
 * закрытая в ночь с пятницы на субботу до 07:00, относится к пятнице — как и должна.
 */
function weekdayOfDayKey(dayKey: string): number | null {
  const ms = Date.parse(`${dayKey}T00:00:00Z`);
  return Number.isFinite(ms) ? new Date(ms).getUTCDay() : null;
}

/** Название дня для текста блокировки; null — в этот день правило #16 не действует. */
export function singleStopWeekdayLabel(dayKey: string): string | null {
  const weekday = weekdayOfDayKey(dayKey);
  return weekday !== null ? (SINGLE_STOP_WEEKDAYS[weekday] ?? null) : null;
}

/**
 * Лимит стопов дня с учётом дня недели. baseLimit — лимит из лестницы пауз
 * (risk/stopChain.ts); правило дня недели может только УЖЕСТОЧИТЬ его, не ослабить.
 */
export function dayStopLimitForDayKey(dayKey: string, baseLimit: number = DAILY_STOP_LOSS_LIMIT): number {
  return singleStopWeekdayLabel(dayKey) !== null
    ? Math.min(baseLimit, SINGLE_STOP_WEEKDAY_LIMIT)
    : baseLimit;
}

/**
 * Сколько тейков за день достаточно, чтобы зафиксировать результат и остановиться —
 * независимо от суммы R (например, два тейка 1:1 дают только +2R, но день уже «удался»).
 */
export const DAILY_TAKE_PROFIT_LIMIT = 2;

/**
 * Минимальный результат тейка (в R), который закрывает день сам по себе (правило #6).
 * 2R = пресет 1:2 и выше. До 02.10.2026 правило требовало стопа ДО такого тейка —
 * теперь не требует: 2R за день достаточно независимо от того, с чего день начался.
 */
export const STRONG_TP_MIN_R = 2;

/**
 * Правило #11 (15.09.2026): если ПРЕДЫДУЩАЯ закрытая сделка — стоп, следующую нельзя
 * открывать с целью дальше R/R 1/2. После убытка дальние цели — это попытка отыграться
 * одним входом; ближняя цель повышает шанс закрыть серию в плюс.
 */
export const MAX_RR_AFTER_STOP = 2;

/**
 * Допуск при сравнении с порогом: цена TP вводится вручную и после округления шага цены
 * биржи может дать 2.01R вместо ровно 2R — это та же цель, а не «дальше 1/2».
 */
export const RR_LIMIT_TOLERANCE = 0.05;

/**
 * Можно ли ставить тейк с таким R/R. previousWasStop берётся из исхода последней закрытой
 * сделки (history/outcome.ts): стоп, уведённый в прибыль, тейком и считается — ограничение
 * после него не включается.
 */
export function isTpRatioAllowed(ratio: number | null, previousWasStop: boolean): boolean {
  if (!previousWasStop || ratio === null) return true;
  return ratio <= MAX_RR_AFTER_STOP + RR_LIMIT_TOLERANCE;
}

/**
 * Дневные лимиты считаются по сумме результатов всех закрытых сделок дня (−2R/+3R), а
 * также по отдельным счётчикам исходов (стопы, тейки, сильный откуп после стопа).
 *
 * Допуск 0.2R на стороне прибыли: комиссии BingX + слиппаж fill могут съесть
 * 0.05–0.15R у тейка 1:3, из-за чего sumR≈2.85 не дотягивал до порога 3.0.
 */
const LIMIT_EPSILON = 0.2;

/** Тейк считается «сильным» (1:2+), если resultR почти достиг STRONG_TP_MIN_R. */
export function isStrongTakeProfit(resultR: number): boolean {
  return resultR >= STRONG_TP_MIN_R - LIMIT_EPSILON;
}

/**
 * Текст блокировки по стопам дня — факт и зачем пауза, без упоминания серии стопов. Про
 * серию говорит отдельный лок `stop_chain`, и только когда она действительно закрывает
 * дни сверх сегодняшнего.
 *
 * Два захода правок по кейсу 01–02.10.2026:
 * 1. Убрано «Стоп при активной серии» — лимит стопов дня фиксируется на НАЧАЛО дня, из-за
 *    чего текст появлялся и тогда, когда тейк того же дня серию уже обнулил, и обещал
 *    выходного, которого не будет.
 * 2. Вместо «торговля возобновится после сброса дня» — зачем эта пауза нужна (просьба
 *    пользователя). Когда торговля откроется, и так видно: под причиной идёт таймер.
 * 3. Укорочено до двух строк на iPhone: первый вариант этой же правки занимал четыре.
 */
function dailyStopLossesReason(slCount: number, weekdayLabel: string | null): string {
  // В ПН и ПТ день закрывает один стоп — называем причину прямо, иначе текст выглядел бы
  // как обычная пауза после стопа, после которой обычно можно торговать дальше.
  if (weekdayLabel !== null && slCount === 1) {
    return `Стоп в ${weekdayLabel} — на сегодня всё`;
  }
  const fact = slCount === 1 ? "Стоп" : `${slCount} стопа за день`;
  return `${fact} — дадим себе и графику расторговаться`;
}

export function evaluateDailyLimitBlocks(
  now: Date,
  counters: DailyLimitCounters,
  config: RiskLimitsConfig,
  /**
   * Сколько стопов за день закрывают торговлю. По умолчанию — обычные два (правило #4);
   * внутри лестницы пауз (risk/stopChain.ts) хватает одного.
   */
  dayStopLimit: number = DAILY_STOP_LOSS_LIMIT,
  /**
   * Ключ торгового дня (risk/tradingDay.ts). Передан — учитываем правило дня недели
   * (#16): в ПН и ПТ день закрывает уже один стоп.
   */
  dayKey?: string,
): Block[] {
  const blocks: Block[] = [];
  const until = getNextResetAt(now, config.resetHour, config.tzOffsetMinutes);

  // Подпись дня недели заполнена ровно в те дни, где правило #16 и ужесточает лимит,
  // поэтому отдельная проверка лимита не нужна.
  const weekdayLabel = dayKey ? singleStopWeekdayLabel(dayKey) : null;
  const effectiveStopLimit = dayKey ? dayStopLimitForDayKey(dayKey, dayStopLimit) : dayStopLimit;

  if (counters.sumR <= config.dailyLossLimitR) {
    blocks.push({
      type: "daily_loss",
      reason: `Дневной лимит ${config.dailyLossLimitR}R достигнут`,
      until,
    });
  }
  if (counters.sumR >= config.dailyProfitLimitR - LIMIT_EPSILON) {
    blocks.push({
      type: "daily_profit",
      reason: `Дневная цель +${config.dailyProfitLimitR}R достигнута`,
      until,
    });
  }
  if (counters.slCount >= effectiveStopLimit) {
    blocks.push({
      type: "daily_stop_losses",
      reason: dailyStopLossesReason(counters.slCount, weekdayLabel),
      until,
    });
  }
  if (counters.tpCount >= DAILY_TAKE_PROFIT_LIMIT) {
    blocks.push({
      type: "daily_take_profits",
      reason: `${counters.tpCount} тейка за день — достаточно`,
      until,
    });
  }
  if (counters.strongTakeProfit) {
    blocks.push({
      type: "daily_strong_tp",
      reason: `Тейк ≥ ${STRONG_TP_MIN_R}R — хватит на сегодня`,
      until,
    });
  }
  if (counters.slCount >= 1 && counters.tpCount >= 1) {
    blocks.push({
      type: "daily_mixed_outcomes",
      reason: "Тейк и стоп за день — хватит",
      until,
    });
  }
  return blocks;
}

/**
 * Добровольная пауза «поберечь депозит до лучшего входа» (правило пользователя от
 * 18.09.2026, с 20.09.2026 ставится кнопкой на дашборде): два часа без входов. Смысл —
 * дать себе простой способ подстраховаться, когда чувствуешь, что момент не твой:
 * импульсивная сделка стоит дороже пропущенной.
 */
export const VOLUNTARY_PAUSE_MINUTES = 120;

export function buildVoluntaryPauseBlock(now: Date): Block {
  const hours = VOLUNTARY_PAUSE_MINUTES / 60;
  return {
    type: "voluntary_pause",
    reason: `Бережём депозит — пауза ${hours} часа`,
    until: new Date(now.getTime() + VOLUNTARY_PAUSE_MINUTES * 60_000),
  };
}

/**
 * Кулдаун после закрытой сделки — антиовертрейдинг. После ТЕЙКА паузы нет (правило
 * пользователя от 26.09.2026): пауза нужна, чтобы не отыгрываться после неудачи, а
 * сработавший план — не та ситуация, от которой надо остывать. После стопа, безубытка
 * и ручного/внешнего закрытия пауза прежняя.
 *
 * «Тейк» здесь — исход по экономике сделки (history/outcome.ts), тот же, которым
 * оперируют дневные лимиты и статистика: стоп, уведённый в прибыль, — это тоже тейк.
 * Иначе история показывала бы «тейк», а движок держал бы паузу как после стопа.
 */
export function evaluateCooldownBlock(
  now: Date,
  lastTradeClosedAt: Date | null,
  cooldownMinutes: number,
  lastTradeOutcome: TradeOutcome | null,
): Block | null {
  if (!lastTradeClosedAt) return null;
  if (lastTradeOutcome === "tp") return null;
  const until = new Date(lastTradeClosedAt.getTime() + cooldownMinutes * 60_000);
  if (until <= now) return null;
  return {
    type: "cooldown",
    reason: "Пауза после сделки — не отыгрываемся",
    until,
  };
}

/**
 * Правило #9: по активу, закрытому сегодня по стопу (closeReason === "sl"), повторный
 * вход запрещён до сброса торгового дня. Другие активы остаются доступны. Manual / TP /
 * external это правило не включают.
 */
export function evaluateAssetSlBlocks(
  now: Date,
  slSymbols: string[],
  config: Pick<RiskLimitsConfig, "resetHour" | "tzOffsetMinutes">,
): Block[] {
  if (slSymbols.length === 0) return [];
  const until = getNextResetAt(now, config.resetHour, config.tzOffsetMinutes);
  const unique = [...new Set(slSymbols.filter((s) => s.length > 0))];
  return unique.map((symbol) => ({
    type: "asset_sl_today" as const,
    symbol,
    reason: `По ${displaySymbol(symbol)} уже был стоп сегодня — повторный вход завтра`,
    until,
  }));
}

/**
 * При нескольких ГЛОБАЛЬНЫХ блокировках действует самая длинная (docs/RISK_ENGINE.md).
 * asset_sl_today сюда не передавать — они per-asset и не закрывают день целиком.
 */
export function pickEffectiveBlock(blocks: Block[]): Block | null {
  const global = blocks.filter(isGlobalBlock);
  if (global.length === 0) return null;
  return global.reduce((longest, current) => (current.until > longest.until ? current : longest));
}

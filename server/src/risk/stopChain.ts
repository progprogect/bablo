import type { TradeOutcome } from "../history/outcome.js";
import { DAILY_STOP_LOSS_LIMIT, type Block, type RiskLimitsConfig } from "./limits.js";
import { getResetAtAfterTradingDay } from "./tradingDay.js";

/**
 * Лестница пауз после стопов (правило пользователя от 26.09.2026).
 *
 * Пока серии нет, работает обычное правило #4: два стопа за день закрывают торговлю до
 * сброса. Но каждое такое срабатывание поднимает ступень, и дальше цена ошибки растёт:
 *
 * | ступень | стопов за день хватает | пауза при срабатывании          |
 * |---------|------------------------|---------------------------------|
 * | 0       | 2                      | до сброса дня                   |
 * | 1       | 1                      | до сброса + 1 полный день       |
 * | 2       | 1                      | до сброса + 2 полных дня        |
 * | n       | 1                      | до сброса + n полных дней       |
 *
 * Смысл правила: серия стопов — признак того, что рынок или состояние не те, и чем
 * дольше она длится, тем дороже следующая попытка «вернуть своё». Любой тейк обнуляет
 * лестницу целиком — значит, торговля снова идёт по плану.
 *
 * Стопы считаются ПОДРЯД: тейк внутри дня сбрасывает и ступень, и счётчик стопов дня,
 * поэтому день SL → TP → SL ступень не поднимает (день всё равно закроется обычным
 * правилом #4 по двум стопам за день — это отдельный счётчик, он тейками не обнуляется).
 *
 * Безубыток и ручное/внешнее закрытие в лестнице не участвуют: стопом не считаются и
 * серию не обнуляют — обнуляет только тейк.
 *
 * «Тейк» и «стоп» здесь — исход по экономике сделки (history/outcome.ts), тот же, что у
 * правил #4/#5/#6/#9 и статистики: стоп, уведённый в прибыль, — это тейк, и серию он
 * обнуляет.
 */

/** Сколько стопов за день закрывают торговлю внутри серии — хватает одного. */
export const CHAIN_DAY_STOP_LIMIT = 1;

export function dayStopLimitForStage(stage: number): number {
  return stage <= 0 ? DAILY_STOP_LOSS_LIMIT : CHAIN_DAY_STOP_LIMIT;
}

/** Исходы закрытых сделок одного торгового дня, по возрастанию времени закрытия. */
export type StopChainDay = {
  dayKey: string;
  outcomes: TradeOutcome[];
};

export type StopChainState = {
  /** Ступень лестницы после всех закрытых сделок. 0 — серии нет. */
  stage: number;
  /**
   * Сколько стопов за СЕГОДНЯ закрывают торговлю. Считается по ступени на НАЧАЛО дня:
   * стоп, который сегодня же поднял ступень, задним числом лимит не меняет.
   */
  todayStopLimit: number;
  /** Торговый день, на котором лестница сработала в последний раз. */
  triggeredDayKey: string | null;
  /** Сколько ПОЛНЫХ дней после triggeredDayKey торговля закрыта (0 — только до сброса). */
  blockedFullDays: number;
};

/**
 * Прогон всей истории закрытых сделок по дням. Чистая функция: состояние лестницы —
 * не хранимое поле, а следствие истории, поэтому ручная переразметка исхода в админке
 * (`statsOutcome`) чинит лестницу сама, без миграций и фоновых задач.
 *
 * `days` — по возрастанию dayKey, исходы внутри дня — по возрастанию времени закрытия.
 */
export function computeStopChain(days: StopChainDay[], todayKey: string): StopChainState {
  let stage = 0;
  let triggeredDayKey: string | null = null;
  let blockedFullDays = 0;
  let todayStopLimit: number | null = null;

  for (const day of days) {
    const stageAtDayStart = stage;
    if (day.dayKey === todayKey) {
      todayStopLimit = dayStopLimitForStage(stageAtDayStart);
    }

    let stopsInRow = 0;
    for (const outcome of day.outcomes) {
      if (outcome === "tp") {
        // Тейк обнуляет лестницу целиком — вместе с уже назначенной паузой.
        stage = 0;
        stopsInRow = 0;
        triggeredDayKey = null;
        blockedFullDays = 0;
        continue;
      }
      if (outcome !== "sl") continue;

      stopsInRow += 1;
      if (stopsInRow < dayStopLimitForStage(stage)) continue;

      // Лестница сработала: пауза тем длиннее, чем выше была ступень.
      blockedFullDays = stage;
      triggeredDayKey = day.dayKey;
      stage += 1;
      stopsInRow = 0;
    }
  }

  return {
    stage,
    todayStopLimit: todayStopLimit ?? dayStopLimitForStage(stage),
    triggeredDayKey,
    blockedFullDays,
  };
}

function pluralDays(count: number): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return "дней";
  switch (count % 10) {
    case 1:
      return "день";
    case 2:
    case 3:
    case 4:
      return "дня";
    default:
      return "дней";
  }
}

/**
 * Блокировка на ПОЛНЫЕ дни сверх текущего — только со второй ступени и выше. Первое
 * срабатывание (два стопа за день) закрывает торговлю до сброса дня и живёт обычным
 * блоком daily_stop_losses, отдельный лок ему не нужен.
 */
export function buildStopChainBlock(
  now: Date,
  state: StopChainState,
  config: RiskLimitsConfig,
): Block | null {
  if (state.triggeredDayKey === null || state.blockedFullDays <= 0) return null;
  const until = getResetAtAfterTradingDay(
    state.triggeredDayKey,
    state.blockedFullDays,
    config.resetHour,
    config.tzOffsetMinutes,
  );
  if (until === null || until <= now) return null;
  const days = state.blockedFullDays;
  return {
    type: "stop_chain",
    reason: `Серия стопов — пауза ещё на ${days} ${pluralDays(days)}. Тейк обнулит серию`,
    until,
  };
}

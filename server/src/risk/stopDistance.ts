import type { TradeSide } from "../trades/math.js";

/**
 * Проверка расстояния между ценой входа и стопом (правило пользователя от 18.10.2026).
 *
 * Процент считается ОТ ЦЕНЫ ВХОДА — та же база, что у инструмента «длинная позиция» в
 * TradingView: там разрыв 0,6782 → 0,6765 подписан как 0,251%, то есть 0,0017 / 0,6782.
 * Округление до сотых.
 *
 * Зачем правило: риск сделки фиксирован в долларах, поэтому объём = риск / расстояние до
 * стопа. Слишком близкий стоп раздувает объём — комиссия и проскальзывание начинают
 * решать исход вместо самой идеи сделки. Слишком далёкий стоп правило ловит явно, хотя
 * частично его уже ловит проверка ликвидации (при плече 20x ликвидация ≈ в 5% от входа).
 */

/** Границы из настроек риск-плана. `null` — без ограничения с этой стороны. */
export type StopDistanceLimits = {
  enabled: boolean;
  minPct: number | null;
  maxPct: number | null;
};

/**
 * Настройки риск-плана → границы. Параметр структурный, а не `RiskSettings`: модуль
 * остаётся чистым и не тянет за собой слой репозиториев.
 *
 * Поля в настройках плоские (`stopDistanceCheckEnabled`, `minStopDistancePct`…), потому
 * что `getRiskSettings` домешивает дефолты ПОВЕРХНОСТНЫМ слиянием: у вложенного объекта
 * запись, сохранённая до появления поля, потеряла бы соседние ключи.
 */
export function stopDistanceLimitsFrom(settings: {
  stopDistanceCheckEnabled: boolean;
  minStopDistancePct: number | null;
  maxStopDistancePct: number | null;
}): StopDistanceLimits {
  return {
    enabled: settings.stopDistanceCheckEnabled,
    minPct: settings.minStopDistancePct,
    maxPct: settings.maxStopDistancePct,
  };
}

export type StopDistanceCheck =
  /** Проверка выключена, границы не заданы или нет данных для расчёта — не мешаем входу. */
  | { status: "off" }
  | { status: "ok"; pct: number }
  | { status: "too_close"; pct: number; limitPct: number; suggestedSl: number }
  | { status: "too_far"; pct: number; limitPct: number; suggestedSl: number };

/** До сотых — и на экране, и в сравнении с границей (см. `stopDistancePct`). */
export function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * «0.41» → «0,41». Запятая, потому что так же выглядит число в TradingView и в остальных
 * денежных строках приложения. Вручную, а не через `toLocaleString`: формат не должен
 * зависеть от наличия ICU в рантайме сервера.
 */
export function formatPct(value: number): string {
  return value.toFixed(2).replace(".", ",");
}

/**
 * Расстояние до стопа в процентах от цены входа, округлённое до сотых.
 *
 * Модуль разницы, поэтому лонг и шорт считаются одной формулой: у лонга стоп ниже входа,
 * у шорта выше, но расстояние в обе стороны измеряется одинаково. Сторону проверяет
 * отдельная проверка направления стопа (`isValidStopLoss`), здесь она не нужна.
 *
 * ВАЖНО: сравнение с границей идёт по ОКРУГЛЁННОМУ значению — тому же, которое видит
 * пользователь. Иначе стоп в 0.7996% показывался бы как «0,80%» и при этом блокировался
 * минимумом 0,80%, и это выглядело бы как баг.
 */
export function stopDistancePct(entryPrice: number, slPrice: number): number | null {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(slPrice)) return null;
  if (!(entryPrice > 0) || !(slPrice > 0)) return null;
  return roundPct((Math.abs(entryPrice - slPrice) / entryPrice) * 100);
}

/**
 * Ближайшая цена стопа, которая укладывается в границу, — для подсказки «отодвиньте SL
 * до ≈…». Вот здесь лонг и шорт РАЗНЫЕ: у лонга стоп ниже входа, значит дальше от входа
 * означает меньшую цену, у шорта — наоборот.
 */
function slPriceAtPct(entryPrice: number, side: TradeSide, pct: number): number {
  const offset = entryPrice * (pct / 100);
  return side === "long" ? entryPrice - offset : entryPrice + offset;
}

export function checkStopDistance(input: {
  side: TradeSide;
  entryPrice: number;
  slPrice: number;
  limits: StopDistanceLimits;
}): StopDistanceCheck {
  const { side, entryPrice, slPrice, limits } = input;
  if (!limits.enabled) return { status: "off" };

  const pct = stopDistancePct(entryPrice, slPrice);
  if (pct === null) return { status: "off" };

  const min = limits.minPct;
  if (min !== null && Number.isFinite(min) && min > 0 && pct < min) {
    return {
      status: "too_close",
      pct,
      limitPct: min,
      suggestedSl: slPriceAtPct(entryPrice, side, min),
    };
  }

  const max = limits.maxPct;
  if (max !== null && Number.isFinite(max) && max > 0 && pct > max) {
    return {
      status: "too_far",
      pct,
      limitPct: max,
      suggestedSl: slPriceAtPct(entryPrice, side, max),
    };
  }

  if (min === null && max === null) return { status: "off" };
  return { status: "ok", pct };
}

/**
 * Текст отказа. Держим в синхроне с клиентской копией в
 * `client/src/screens/dashboard/TradeForm.tsx` — пользователь должен видеть одну и ту же
 * формулировку и до отправки (живая проверка), и в ответе сервера.
 */
export function stopDistanceRejectMessage(
  check: Extract<StopDistanceCheck, { status: "too_close" | "too_far" }>,
): string {
  const pct = formatPct(check.pct);
  const limit = formatPct(check.limitPct);
  const price = check.suggestedSl.toFixed(4);
  return check.status === "too_close"
    ? `Стоп в ${pct}% от входа — ближе минимума ${limit}%. Отодвиньте SL до ≈${price} или дальше.`
    : `Стоп в ${pct}% от входа — дальше максимума ${limit}%. Приблизьте SL до ≈${price} или ближе.`;
}

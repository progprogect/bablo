import type { TradeSide } from "./math.js";

/**
 * Трейлинг-лестница стопа для ПОЛНЫХ тейков (100% объёма, без частичной фиксации) —
 * правило пользователя от 31.08.2026: если цена дала заметный ход к далёкому тейку,
 * стоп подтягивается ступенями, чтобы при откате забрать хотя бы часть.
 *
 * triggerR — сколько R цена должна пройти от входа; slR — куда переносится стоп
 * (0 = точка входа, 1 = +1R и т.д.). Уровни считаются от ИСХОДНОГО риска
 * (riskUsd / quantity), как и ночное правило, — уже подтянутый стоп расчёт не искажает.
 */
export type TrailingLevel = { triggerR: number; slR: number };

const TRAILING_LADDERS: Record<string, TrailingLevel[]> = {
  "1/3": [
    { triggerR: 2, slR: 0 },
    { triggerR: 2.5, slR: 1 },
  ],
  "1/4": [
    { triggerR: 2, slR: 0 },
    { triggerR: 2.5, slR: 1 },
    { triggerR: 3, slR: 2 },
    { triggerR: 3.5, slR: 2.5 },
  ],
};

export function trailingLadderFor(rrPreset: string | null): TrailingLevel[] | null {
  if (!rrPreset) return null;
  return TRAILING_LADDERS[rrPreset] ?? null;
}

export type TrailingDecision =
  /** Уровень не достигнут (или сделка не под лестницей) — ничего не делать. */
  | { action: "skip"; reason: string }
  /**
   * Уровень достигнут, но двигать стоп некуда (он уже не хуже целевого — например,
   * ночное правило уже подтянуло на 1R): фиксируем прогресс, чтобы уровень не
   * переоценивался на каждом тике.
   */
  | { action: "settle"; triggerR: number }
  | { action: "move"; triggerR: number; slR: number; newSlPrice: number };

export function decideTrailingSlMove(input: {
  rrPreset: string | null;
  side: TradeSide;
  entryPrice: number;
  /** Текущий стоп (может быть уже подтянут другими правилами). */
  currentSlPrice: number | null;
  /** Исходный риск сделки в $ — база уровней (riskUsd / quantity = дистанция 1R). */
  riskUsd: number;
  quantity: number;
  /** Задана частичная фиксация — лестница не применяется (правило пользователя). */
  partialTpPrice: number | null;
  /** Последний применённый triggerR (из БД) — каждый уровень срабатывает один раз. */
  appliedTriggerR: number | null;
  price: number;
}): TrailingDecision {
  const ladder = trailingLadderFor(input.rrPreset);
  if (!ladder) return { action: "skip", reason: "пресет без трейлинг-лестницы" };
  if (input.partialTpPrice !== null) {
    return { action: "skip", reason: "есть частичная фиксация — лестница не применяется" };
  }
  if (!(input.entryPrice > 0) || !(input.riskUsd > 0) || !(input.quantity > 0)) {
    return { action: "skip", reason: "нет данных для расчёта уровней" };
  }

  const riskDistance = input.riskUsd / input.quantity;
  if (!(riskDistance > 0)) return { action: "skip", reason: "нулевая дистанция риска" };

  const reachedR =
    input.side === "long"
      ? (input.price - input.entryPrice) / riskDistance
      : (input.entryPrice - input.price) / riskDistance;

  // Наивысший достигнутый уровень, который ещё не применялся: при резком движении цена
  // может проскочить несколько ступеней — двигаем сразу на верхнюю.
  const level = ladder
    .filter(
      (candidate) =>
        reachedR >= candidate.triggerR &&
        (input.appliedTriggerR === null || candidate.triggerR > input.appliedTriggerR),
    )
    .at(-1);
  if (!level) return { action: "skip", reason: "уровень не достигнут" };

  const newSlPrice =
    input.side === "long"
      ? input.entryPrice + level.slR * riskDistance
      : input.entryPrice - level.slR * riskDistance;

  // Только сужение: стоп двигается исключительно К прибыли. Если он уже там или дальше
  // (ночное правило 1/1 могло опередить лестницу) — двигать нечего.
  if (input.currentSlPrice !== null) {
    const tightens =
      input.side === "long"
        ? newSlPrice > input.currentSlPrice
        : newSlPrice < input.currentSlPrice;
    if (!tightens) return { action: "settle", triggerR: level.triggerR };
  }

  return { action: "move", triggerR: level.triggerR, slR: level.slR, newSlPrice };
}

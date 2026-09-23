/**
 * Структура цены для журнала (запрос пользователя от 23.09.2026): уровни
 * поддержки/сопротивления, зоны накопления (консолидации) и сломы структуры (BOS).
 * Чистые функции без I/O, под тестами (structure.test.ts). Используются дважды:
 * сервер отдаёт структуру вместе со свечами графика (рисуется в рабочей зоне),
 * а выжимка на момент входа сохраняется в journal_trade_metrics для анализа.
 */

import { atrSeries, type Candle } from "./indicators.js";

// --- Свинг-точки -----------------------------------------------------------------------------

export type Swing = { index: number; time: number; price: number; kind: "high" | "low" };

/**
 * Фрактальные свинги: high выше high соседних wing свечей с обеих сторон (для low —
 * зеркально). Последние wing свечей свинга дать не могут — не подтверждены.
 */
export function findSwings(candles: Candle[], wing = 2): Swing[] {
  const swings: Swing[] = [];
  for (let i = wing; i < candles.length - wing; i += 1) {
    const candle = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - wing; j <= i + wing; j += 1) {
      if (j === i) continue;
      if (candles[j]!.high >= candle.high) isHigh = false;
      if (candles[j]!.low <= candle.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ index: i, time: candle.time, price: candle.high, kind: "high" });
    if (isLow) swings.push({ index: i, time: candle.time, price: candle.low, kind: "low" });
  }
  return swings;
}

// --- Уровни ----------------------------------------------------------------------------------

export type PriceLevel = {
  price: number;
  /** Сколько свингов легло в кластер уровня — «сила» уровня. */
  touches: number;
  kind: "support" | "resistance" | "mixed";
};

/**
 * Кластеризация свингов в уровни: свинги ближе tolerance друг к другу сливаются,
 * цена уровня — среднее кластера. Возвращаются уровни с touches ≥ minTouches,
 * сильные первыми.
 */
export function buildLevels(swings: Swing[], tolerance: number, minTouches = 2): PriceLevel[] {
  if (tolerance <= 0 || swings.length === 0) return [];
  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const levels: PriceLevel[] = [];
  let cluster: Swing[] = [];

  const flush = () => {
    if (cluster.length < minTouches) {
      cluster = [];
      return;
    }
    const price = cluster.reduce((sum, swing) => sum + swing.price, 0) / cluster.length;
    const highs = cluster.filter((swing) => swing.kind === "high").length;
    const lows = cluster.length - highs;
    levels.push({
      price,
      touches: cluster.length,
      kind: highs === 0 ? "support" : lows === 0 ? "resistance" : "mixed",
    });
    cluster = [];
  };

  for (const swing of sorted) {
    if (cluster.length === 0 || swing.price - cluster[cluster.length - 1]!.price <= tolerance) {
      cluster.push(swing);
    } else {
      flush();
      cluster.push(swing);
    }
  }
  flush();
  return levels.sort((a, b) => b.touches - a.touches);
}

// --- Зоны накопления --------------------------------------------------------------------------

export type ConsolidationZone = { fromTime: number; toTime: number; high: number; low: number };

/**
 * Зона накопления: не меньше window подряд свечей, чей общий диапазон (max high − min low)
 * не превышает rangeAtr × ATR. Ищется жадно: окно расширяется, пока условие держится;
 * пересекающиеся окна сливаются в одну зону.
 */
export function findConsolidationZones(
  candles: Candle[],
  options: { window?: number; rangeAtr?: number } = {},
): ConsolidationZone[] {
  const window = options.window ?? 24;
  const rangeAtr = options.rangeAtr ?? 1.6;
  if (candles.length < window + 15) return [];
  const atr = atrSeries(candles, 14);
  const zones: ConsolidationZone[] = [];
  let start = 0;

  while (start + window <= candles.length) {
    const referenceAtr = atr[Math.min(start + window - 1, atr.length - 1)];
    if (referenceAtr === null || referenceAtr === undefined || referenceAtr <= 0) {
      start += 1;
      continue;
    }
    const maxRange = rangeAtr * referenceAtr;
    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    let end = start;
    while (end < candles.length) {
      const nextHigh = Math.max(high, candles[end]!.high);
      const nextLow = Math.min(low, candles[end]!.low);
      if (nextHigh - nextLow > maxRange) break;
      high = nextHigh;
      low = nextLow;
      end += 1;
    }
    const length = end - start;
    if (length >= window) {
      const zone = { fromTime: candles[start]!.time, toTime: candles[end - 1]!.time, high, low };
      const previous = zones[zones.length - 1];
      // Слить с предыдущей, если пересекаются по времени.
      if (previous && zone.fromTime <= previous.toTime) {
        previous.toTime = zone.toTime;
        previous.high = Math.max(previous.high, zone.high);
        previous.low = Math.min(previous.low, zone.low);
      } else {
        zones.push(zone);
      }
      start = end - Math.floor(window / 2); // возможное продолжение с перекрытием
    } else {
      start += 1;
    }
  }
  return zones;
}

// --- Сломы структуры (BOS) --------------------------------------------------------------------

export type StructureBreak = {
  time: number;
  /** Цена сломанного свинга. */
  price: number;
  /** up — закрытие выше последнего swing high; down — ниже последнего swing low. */
  direction: "up" | "down";
};

/**
 * Слом структуры: свеча ЗАКРЫВАЕТСЯ за последним подтверждённым свингом (close выше
 * swing high → up, ниже swing low → down). После слома соответствующий свинг считается
 * «взятым» — следующий слом в ту же сторону ждёт нового свинга.
 */
export function findStructureBreaks(candles: Candle[], swings: Swing[]): StructureBreak[] {
  const breaks: StructureBreak[] = [];
  let lastHigh: Swing | null = null;
  let lastLow: Swing | null = null;
  let swingCursor = 0;

  for (let i = 0; i < candles.length; i += 1) {
    // Свинг с индексом s.index подтверждается только через wing свечей — но порядок
    // обхода по index уже это учитывает: используем свинги со index < i.
    while (swingCursor < swings.length && swings[swingCursor]!.index < i) {
      const swing = swings[swingCursor]!;
      if (swing.kind === "high") lastHigh = swing;
      else lastLow = swing;
      swingCursor += 1;
    }
    const candle = candles[i]!;
    if (lastHigh && candle.close > lastHigh.price) {
      breaks.push({ time: candle.time, price: lastHigh.price, direction: "up" });
      lastHigh = null;
    }
    if (lastLow && candle.close < lastLow.price) {
      breaks.push({ time: candle.time, price: lastLow.price, direction: "down" });
      lastLow = null;
    }
  }
  return breaks;
}

// --- Поглощения (engulfing) --------------------------------------------------------------------

export type Engulfing = { index: number; time: number; direction: "bull" | "bear" };

/**
 * Классическое поглощение: тело свечи полностью перекрывает тело предыдущей, направления
 * противоположны, у обеих тел ненулевая величина. bull — зелёная поглотила красную,
 * bear — красная зелёную (запрос пользователя от 23.09.2026: «видеть, где было поглощение»).
 */
export function findEngulfings(candles: Candle[]): Engulfing[] {
  const result: Engulfing[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1]!;
    const cur = candles[i]!;
    const prevBull = prev.close > prev.open;
    const curBull = cur.close > cur.open;
    if (prev.close === prev.open || cur.close === cur.open || prevBull === curBull) continue;
    const prevTop = Math.max(prev.open, prev.close);
    const prevBottom = Math.min(prev.open, prev.close);
    const curTop = Math.max(cur.open, cur.close);
    const curBottom = Math.min(cur.open, cur.close);
    if (curTop >= prevTop && curBottom <= prevBottom && curTop - curBottom > prevTop - prevBottom) {
      result.push({ index: i, time: cur.time, direction: curBull ? "bull" : "bear" });
    }
  }
  return result;
}

// --- Сборка для графика и метрик ---------------------------------------------------------------

export type PriceStructure = {
  levels: PriceLevel[];
  zones: ConsolidationZone[];
  breaks: StructureBreak[];
  engulfings: Engulfing[];
};

export const STRUCTURE_MAX_LEVELS = 6;

/** Полная структура по свечам окна: уровни (топ по силе), зоны, сломы. */
export function buildStructure(candles: Candle[]): PriceStructure {
  if (candles.length < 30) return { levels: [], zones: [], breaks: [], engulfings: [] };
  const atr = atrSeries(candles, 14);
  const lastAtr = atr[atr.length - 1] ?? null;
  const swings = findSwings(candles);
  const tolerance = lastAtr !== null ? lastAtr * 0.6 : 0;
  return {
    levels: buildLevels(swings, tolerance, 3).slice(0, STRUCTURE_MAX_LEVELS),
    zones: findConsolidationZones(candles),
    breaks: findStructureBreaks(candles, swings),
    engulfings: findEngulfings(candles),
  };
}

export type StructureSnapshot = {
  /** Топ-уровни окна (цена, касания, тип). */
  levels: PriceLevel[];
  /** Последний слом структуры ДО входа: направление, цена и давность в свечах. */
  lastBosBeforeEntry: (StructureBreak & { candlesAgo: number }) | null;
  /** Вход внутри зоны накопления (по цене входа и времени). */
  entryInsideZone: boolean;
  /** Последнее поглощение ДО входа: направление и давность в свечах. */
  lastEngulfingBeforeEntry: { direction: "bull" | "bear"; candlesAgo: number } | null;
};

/** Выжимка структуры на момент входа — в journal_trade_metrics. */
export function structureSnapshotAtEntry(
  candles: Candle[],
  stepMs: number,
  entryTimeMs: number,
  entryPrice: number | null,
): StructureSnapshot {
  const structure = buildStructure(candles);
  let lastBos: (StructureBreak & { candlesAgo: number }) | null = null;
  for (const brk of structure.breaks) {
    if (brk.time + stepMs <= entryTimeMs) {
      lastBos = { ...brk, candlesAgo: Math.round((entryTimeMs - brk.time) / stepMs) };
    }
  }
  const entryInsideZone =
    entryPrice !== null &&
    structure.zones.some(
      (zone) =>
        entryTimeMs >= zone.fromTime &&
        entryTimeMs <= zone.toTime + stepMs &&
        entryPrice >= zone.low &&
        entryPrice <= zone.high,
    );
  let lastEngulfing: StructureSnapshot["lastEngulfingBeforeEntry"] = null;
  for (const engulfing of structure.engulfings) {
    if (engulfing.time + stepMs <= entryTimeMs) {
      lastEngulfing = {
        direction: engulfing.direction,
        candlesAgo: Math.round((entryTimeMs - engulfing.time) / stepMs),
      };
    }
  }
  return {
    levels: structure.levels,
    lastBosBeforeEntry: lastBos,
    entryInsideZone,
    lastEngulfingBeforeEntry: lastEngulfing,
  };
}

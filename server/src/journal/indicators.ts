/**
 * Индикаторы и производные сделки для будущего анализа (журнал). Чистые функции без
 * I/O — по образцу risk/limits.ts. Значения считаются из свечей BingX в момент сбора
 * данных сделки (journal/marketData.ts) и складываются в journal_trade_metrics; в UI
 * не выводятся (решение пользователя от 23.09.2026 — «в базе, на будущее»).
 *
 * METRICS_VERSION поднимается при любом изменении формул: по нему видно, чем считался
 * старый снапшот, и что пересчитать.
 */

export const METRICS_VERSION = 2;

export type Candle = {
  /** Время открытия свечи, ms. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

// --- Базовые ряды -------------------------------------------------------------------------

/** SMA последних period значений на индексе index (включительно); null, если не хватает. */
export function smaAt(values: number[], period: number, index: number): number | null {
  if (index + 1 < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) sum += values[i]!;
  return sum / period;
}

/** Ряд EMA: первые period-1 значений — null, seed — SMA первых period. */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return result;
  let ema = 0;
  for (let i = 0; i < period; i += 1) ema += values[i]!;
  ema /= period;
  result[period - 1] = ema;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    ema = values[i]! * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

/** RSI Уайлдера. Первые period значений — null. */
export function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return result;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = closes[i]! - closes[i - 1]!;
    if (delta > 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = closes[i]! - closes[i - 1]!;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = toRsi(avgGain, avgLoss);
  }
  return result;
}

function toRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** ATR Уайлдера по свечам. Первые period значений — null. */
export function atrSeries(candles: Candle[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period) return result;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i]!;
    const prevClose = candles[i - 1]!.close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  let atr = 0;
  for (let i = 0; i < period; i += 1) atr += trs[i]!;
  atr /= period;
  result[period] = atr;
  for (let i = period; i < trs.length; i += 1) {
    atr = (atr * (period - 1) + trs[i]!) / period;
    result[i + 1] = atr;
  }
  return result;
}

/** Максимум high и минимум low за последние period свечей на index; null при нехватке. */
export function donchianAt(
  candles: Candle[],
  period: number,
  index: number,
): { high: number; low: number } | null {
  if (index + 1 < period) return null;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  for (let i = index - period + 1; i <= index; i += 1) {
    high = Math.max(high, candles[i]!.high);
    low = Math.min(low, candles[i]!.low);
  }
  return { high, low };
}

/** Stochastic %K (raw) на index: (close − minLow) / (maxHigh − minLow) × 100. */
function stochKAt(candles: Candle[], period: number, index: number): number | null {
  const channel = donchianAt(candles, period, index);
  if (!channel) return null;
  const span = channel.high - channel.low;
  if (span === 0) return 50;
  return ((candles[index]!.close - channel.low) / span) * 100;
}

/** Stochastic(14, 3): %K и его SMA(3) как %D. */
export function stochasticAt(
  candles: Candle[],
  index: number,
  period = 14,
  smooth = 3,
): { k: number; d: number } | null {
  const k = stochKAt(candles, period, index);
  if (k === null) return null;
  let sum = 0;
  for (let i = index - smooth + 1; i <= index; i += 1) {
    const value = i >= 0 ? stochKAt(candles, period, i) : null;
    if (value === null) return null;
    sum += value;
  }
  return { k, d: sum / smooth };
}

/** Williams %R(14): −100 × (maxHigh − close) / (maxHigh − minLow). */
export function williamsRAt(candles: Candle[], index: number, period = 14): number | null {
  const channel = donchianAt(candles, period, index);
  if (!channel) return null;
  const span = channel.high - channel.low;
  if (span === 0) return -50;
  return (-100 * (channel.high - candles[index]!.close)) / span;
}

/** CCI(20): (typicalPrice − SMA) / (0.015 × среднее абсолютное отклонение). */
export function cciAt(candles: Candle[], index: number, period = 20): number | null {
  if (index + 1 < period) return null;
  const typical = (i: number) => (candles[i]!.high + candles[i]!.low + candles[i]!.close) / 3;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) sum += typical(i);
  const mean = sum / period;
  let deviation = 0;
  for (let i = index - period + 1; i <= index; i += 1) deviation += Math.abs(typical(i) - mean);
  const meanDeviation = deviation / period;
  if (meanDeviation === 0) return 0;
  return (typical(index) - mean) / (0.015 * meanDeviation);
}

/** ADX(14) с DI± по Уайлдеру. Ряды; первые ~2×period значений — null. */
export function adxSeries(
  candles: Candle[],
  period = 14,
): { adx: number | null; plusDi: number | null; minusDi: number | null }[] {
  type AdxRow = { adx: number | null; plusDi: number | null; minusDi: number | null };
  const n = candles.length;
  const result: AdxRow[] = Array.from({ length: n }, () => ({ adx: null, plusDi: null, minusDi: null }));
  if (n <= period * 2) return result;

  const tr: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let i = 1; i < n; i += 1) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  for (let i = 0; i < period; i += 1) {
    trSum += tr[i]!;
    plusSum += plusDm[i]!;
    minusSum += minusDm[i]!;
  }
  const dxs: number[] = [];
  let adx: number | null = null;
  for (let i = period; i <= tr.length; i += 1) {
    const plusDi = trSum === 0 ? 0 : (100 * plusSum) / trSum;
    const minusDi = trSum === 0 ? 0 : (100 * minusSum) / trSum;
    const diSum = plusDi + minusDi;
    const dx = diSum === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / diSum;
    dxs.push(dx);
    if (dxs.length === period) {
      adx = dxs.reduce((total, value) => total + value, 0) / period;
    } else if (dxs.length > period && adx !== null) {
      adx = (adx * (period - 1) + dx) / period;
    }
    // Свеча i (индекс в candles): tr[i-1] — последний учтённый.
    result[i]!.plusDi = plusDi;
    result[i]!.minusDi = minusDi;
    result[i]!.adx = dxs.length >= period ? adx : null;
    if (i < tr.length) {
      trSum = trSum - trSum / period + tr[i]!;
      plusSum = plusSum - plusSum / period + plusDm[i]!;
      minusSum = minusSum - minusSum / period + minusDm[i]!;
    }
  }
  return result;
}

/** VWAP от начала UTC-суток свечи index до неё включительно (по typical price). */
export function dayVwapAt(candles: Candle[], index: number): number | null {
  const dayStart = new Date(candles[index]!.time);
  dayStart.setUTCHours(0, 0, 0, 0);
  const fromMs = dayStart.getTime();
  let volumeSum = 0;
  let pvSum = 0;
  for (let i = index; i >= 0 && candles[i]!.time >= fromMs; i -= 1) {
    const c = candles[i]!;
    const typical = (c.high + c.low + c.close) / 3;
    pvSum += typical * c.volume;
    volumeSum += c.volume;
  }
  if (volumeSum === 0) return null;
  return pvSum / volumeSum;
}

// --- Снапшот на момент входа ---------------------------------------------------------------

export type IndicatorSnapshot = {
  /** Время свечи, по которой снят снапшот (последняя ЗАКРЫТАЯ до входа), ms. */
  candleTime: number;
  close: number;
  rsi14: number | null;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  ema200: number | null;
  /** Дистанции цены до EMA в процентах: (close − ema) / ema × 100. */
  priceToEma21Pct: number | null;
  priceToEma50Pct: number | null;
  priceToEma200Pct: number | null;
  atr14: number | null;
  /** ATR в процентах цены — сопоставимая между активами волатильность. */
  atrPct: number | null;
  macd: { line: number; signal: number; histogram: number } | null;
  bollinger: {
    upper: number;
    middle: number;
    lower: number;
    /** Положение цены в канале: 0 — нижняя граница, 1 — верхняя. */
    percentB: number;
    /** Ширина канала в процентах middle. */
    bandwidthPct: number;
  } | null;
  /** Объём свечи к SMA(20) объёма. */
  volumeRatio20: number | null;
  // --- v2 (23.09.2026) ---
  stochastic14: { k: number; d: number } | null;
  williamsR14: number | null;
  cci20: number | null;
  adx14: { adx: number | null; plusDi: number | null; minusDi: number | null } | null;
  /** Канал Дончиана(20) и положение цены в нём (0 — низ, 100 — верх). */
  donchian20: { high: number; low: number; positionPct: number } | null;
  /** VWAP текущих UTC-суток и дистанция цены до него в %. */
  dayVwap: number | null;
  priceToVwapPct: number | null;
  /** Анатомия последней закрытой свечи в долях ATR: тело и тени. */
  candleAnatomy: { bodyAtr: number; upperWickAtr: number; lowerWickAtr: number } | null;
};

/**
 * Индекс последней свечи, ЗАКРЫТОЙ к моменту atMs: свеча, в которой момент находится,
 * ещё формировалась — «на входе» честны только значения по предыдущей.
 */
export function lastClosedIndex(candles: Candle[], atMs: number, stepMs: number): number | null {
  let index: number | null = null;
  for (let i = 0; i < candles.length; i += 1) {
    if (candles[i]!.time + stepMs <= atMs) index = i;
    else break;
  }
  return index;
}

export function snapshotAt(candles: Candle[], index: number): IndicatorSnapshot {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const close = closes[index]!;

  const ema9 = emaSeries(closes, 9)[index] ?? null;
  const ema21 = emaSeries(closes, 21)[index] ?? null;
  const ema50 = emaSeries(closes, 50)[index] ?? null;
  const ema200 = emaSeries(closes, 200)[index] ?? null;

  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i += 1) {
    const fast = ema12[i];
    const slow = ema26[i];
    macdLine.push(fast !== null && fast !== undefined && slow !== null && slow !== undefined ? fast - slow : NaN);
  }
  const firstMacd = macdLine.findIndex((v) => Number.isFinite(v));
  let macd: IndicatorSnapshot["macd"] = null;
  if (firstMacd >= 0) {
    const signalSeries = emaSeries(macdLine.slice(firstMacd), 9);
    const signal = signalSeries[index - firstMacd] ?? null;
    const line = macdLine[index];
    if (signal !== null && line !== undefined && Number.isFinite(line)) {
      macd = { line, signal, histogram: line - signal };
    }
  }

  const middle = smaAt(closes, 20, index);
  let bollinger: IndicatorSnapshot["bollinger"] = null;
  if (middle !== null) {
    let variance = 0;
    for (let i = index - 19; i <= index; i += 1) variance += (closes[i]! - middle) ** 2;
    const stddev = Math.sqrt(variance / 20);
    const upper = middle + 2 * stddev;
    const lower = middle - 2 * stddev;
    bollinger = {
      upper,
      middle,
      lower,
      percentB: upper === lower ? 0.5 : (close - lower) / (upper - lower),
      bandwidthPct: middle === 0 ? 0 : ((upper - lower) / middle) * 100,
    };
  }

  const atr14 = atrSeries(candles, 14)[index] ?? null;
  const rsi14 = rsiSeries(closes, 14)[index] ?? null;
  const volumeSma = smaAt(volumes, 20, index);

  const pct = (ema: number | null) => (ema === null || ema === 0 ? null : ((close - ema) / ema) * 100);

  const donchianChannel = donchianAt(candles, 20, index);
  const donchian20 =
    donchianChannel === null
      ? null
      : {
          high: donchianChannel.high,
          low: donchianChannel.low,
          positionPct:
            donchianChannel.high === donchianChannel.low
              ? 50
              : ((close - donchianChannel.low) / (donchianChannel.high - donchianChannel.low)) * 100,
        };
  const dayVwap = dayVwapAt(candles, index);
  const adxRow = adxSeries(candles, 14)[index] ?? null;
  const current = candles[index]!;
  const candleAnatomy =
    atr14 === null || atr14 === 0
      ? null
      : {
          bodyAtr: Math.abs(current.close - current.open) / atr14,
          upperWickAtr: (current.high - Math.max(current.open, current.close)) / atr14,
          lowerWickAtr: (Math.min(current.open, current.close) - current.low) / atr14,
        };

  return {
    candleTime: candles[index]!.time,
    close,
    rsi14,
    ema9,
    ema21,
    ema50,
    ema200,
    priceToEma21Pct: pct(ema21),
    priceToEma50Pct: pct(ema50),
    priceToEma200Pct: pct(ema200),
    atr14,
    atrPct: atr14 === null || close === 0 ? null : (atr14 / close) * 100,
    macd,
    bollinger,
    volumeRatio20: volumeSma === null || volumeSma === 0 ? null : volumes[index]! / volumeSma,
    stochastic14: stochasticAt(candles, index),
    williamsR14: williamsRAt(candles, index),
    cci20: cciAt(candles, index),
    adx14: adxRow !== null && adxRow.plusDi !== null ? adxRow : null,
    donchian20,
    dayVwap,
    priceToVwapPct: dayVwap === null || dayVwap === 0 ? null : ((close - dayVwap) / dayVwap) * 100,
    candleAnatomy,
  };
}

// --- Экскурсии сделки по свечам -------------------------------------------------------------

export type TradeExcursions = {
  /** Максимальный ход ПРОТИВ позиции в R (MAE) — трекер его не писал, свечи восстанавливают. */
  maeR: number | null;
  /** Максимальный ход ЗА позицию в R по свечам — сверка с MFE трекера. */
  mfeRFromCandles: number | null;
};

/**
 * MAE/MFE по свечам за время сделки (приближение точностью таймфрейма: экстремумы
 * внутри свечи датируются её интервалом). Свечи должны накрывать [openedMs, closedMs].
 */
export function computeExcursions(
  candles: Candle[],
  side: "long" | "short",
  entryPrice: number,
  riskDistance: number,
  openedMs: number,
  closedMs: number,
  stepMs: number,
): TradeExcursions {
  if (!(riskDistance > 0)) return { maeR: null, mfeRFromCandles: null };
  let worst = entryPrice;
  let best = entryPrice;
  let covered = false;
  for (const candle of candles) {
    if (candle.time + stepMs <= openedMs || candle.time > closedMs) continue;
    covered = true;
    if (side === "long") {
      worst = Math.min(worst, candle.low);
      best = Math.max(best, candle.high);
    } else {
      worst = Math.max(worst, candle.high);
      best = Math.min(best, candle.low);
    }
  }
  if (!covered) return { maeR: null, mfeRFromCandles: null };
  const mae = side === "long" ? entryPrice - worst : worst - entryPrice;
  const mfe = side === "long" ? best - entryPrice : entryPrice - best;
  return { maeR: mae / riskDistance, mfeRFromCandles: mfe / riskDistance };
}

/**
 * Индикаторы и производные сделки для будущего анализа (журнал). Чистые функции без
 * I/O — по образцу risk/limits.ts. Значения считаются из свечей BingX в момент сбора
 * данных сделки (journal/marketData.ts) и складываются в journal_trade_metrics; в UI
 * не выводятся (решение пользователя от 23.09.2026 — «в базе, на будущее»).
 *
 * METRICS_VERSION поднимается при любом изменении формул: по нему видно, чем считался
 * старый снапшот, и что пересчитать.
 */

export const METRICS_VERSION = 1;

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

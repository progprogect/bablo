"""
Реплей сделки по свечам: «что было бы, если бы стоп/тейк/вход стояли иначе».

Честность важнее красивых цифр, поэтому:

  * Свечи кончились, а ни стоп, ни тейк не задеты -> UNDETERMINED. Это НЕ победа.
    Молча считать такие сделки тейками — главный способ нарисовать себе грааль.
  * Внутри одной свечи задеты и стоп, и тейк -> порядок неизвестен. Считаем ДВА
    сценария: pessimistic (первым стоп) и optimistic (первым тейк). Заголовочная
    цифра всегда пессимистичная, оптимистичная — верхняя граница.
  * Перевод в безубыток активируется со СЛЕДУЮЩЕЙ свечи после той, где экстремум
    дотянулся до триггера: внутри свечи порядок «сначала +1R, потом откат» не виден.
  * Реплей калибруется: сначала прогоняем ФАКТИЧЕСКИЕ стоп и тейк и смотрим, какую
    долю реальных исходов движок воспроизводит (reproduction accuracy). Все выводы
    «а если бы» стоят ровно столько, сколько стоит эта доля.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

UNDETERMINED = "undetermined"


@dataclass
class ReplayResult:
    outcome: str          # 'tp' | 'sl' | 'be' | 'timeout' | 'undetermined'
    result_r: float       # результат в R (nan для undetermined)
    bars_held: int
    exit_price: float
    ambiguous_bar: bool   # был ли бар, где задеты обе цели


def find_bar_index(t_ms: np.ndarray, at_ms: int, step_ms: int) -> int | None:
    """Индекс свечи, ВНУТРИ которой находится момент at_ms."""
    if t_ms.size == 0:
        return None
    idx = int(np.searchsorted(t_ms, at_ms, side="right")) - 1
    if idx < 0:
        return None
    if at_ms >= t_ms[idx] + step_ms:
        return None  # дыра в данных: момент за пределами этой свечи
    return idx


def replay(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    start_idx: int,
    side: str,
    entry_price: float,
    sl_price: float,
    tp_price: float | None,
    risk_distance: float,
    *,
    be_trigger_r: float | None = None,
    max_bars: int | None = None,
    optimistic: bool = False,
) -> ReplayResult:
    """
    Прогон одной сделки по свечам [start_idx ..] до стопа, тейка или конца данных.

    optimistic=True меняет только разрешение неоднозначной свечи (обе цели задеты):
    True — первым сработал тейк, False — первым стоп.
    """
    n = high.size
    if start_idx >= n or not np.isfinite(risk_distance) or risk_distance <= 0:
        return ReplayResult(UNDETERMINED, np.nan, 0, np.nan, False)

    is_long = side == "long"
    sign = 1.0 if is_long else -1.0
    stop = float(sl_price)
    be_armed = False
    ambiguous = False

    limit = n if max_bars is None else min(n, start_idx + max_bars)

    for i in range(start_idx, limit):
        hit_sl = low[i] <= stop if is_long else high[i] >= stop
        hit_tp = False
        if tp_price is not None:
            hit_tp = high[i] >= tp_price if is_long else low[i] <= tp_price

        if hit_sl and hit_tp:
            ambiguous = True
            first_tp = optimistic
        elif hit_tp:
            first_tp = True
        elif hit_sl:
            first_tp = False
        else:
            # Безубыток вооружается по ЗАКРЫТОЙ свече, действует со следующей.
            if be_trigger_r is not None and not be_armed:
                extreme = high[i] if is_long else low[i]
                reached_r = sign * (extreme - entry_price) / risk_distance
                if reached_r >= be_trigger_r:
                    be_armed = True
                    stop = entry_price
            continue

        bars = i - start_idx + 1
        if first_tp:
            exit_price = float(tp_price)
            r = sign * (exit_price - entry_price) / risk_distance
            return ReplayResult("tp", r, bars, exit_price, ambiguous)

        exit_price = stop
        r = sign * (exit_price - entry_price) / risk_distance
        outcome = "be" if (be_armed and abs(r) <= 1e-9) else "sl"
        return ReplayResult(outcome, r, bars, exit_price, ambiguous)

    # Дошли до лимита баров, цели не задеты
    if max_bars is not None and limit == start_idx + max_bars and limit < n:
        exit_price = float(close[limit - 1])
        r = sign * (exit_price - entry_price) / risk_distance
        return ReplayResult("timeout", r, limit - start_idx, exit_price, ambiguous)

    # Свечи кончились — исход неизвестен, и мы честно это говорим
    return ReplayResult(UNDETERMINED, np.nan, limit - start_idx, np.nan, ambiguous)


class TradeReplayer:
    """
    Реплей с каскадом таймфреймов: 5m -> 15m -> 1h.

    5m точнее всех, но его окно кончается через 6ч после закрытия. Если на нём исход
    не определился, пробуем 15m (окно +1 день), затем 1h (+3 дня). В результат
    пишется, какой таймфрейм дал ответ, — это видно в отчёте.
    """

    TIERS = (("5m", 5 * 60_000), ("15m", 15 * 60_000), ("1h", 60 * 60_000))

    def __init__(self, candles: dict[tuple[str, str], "object"]):
        self.arrays: dict[tuple[str, str], dict[str, np.ndarray]] = {}
        for key, df in candles.items():
            self.arrays[key] = {
                "t": df["t_ms"].to_numpy(dtype=np.int64),
                "o": df["open"].to_numpy(dtype=float),
                "h": df["high"].to_numpy(dtype=float),
                "l": df["low"].to_numpy(dtype=float),
                "c": df["close"].to_numpy(dtype=float),
            }

    def run(
        self,
        symbol: str,
        side: str,
        opened_ms: int,
        entry_price: float,
        risk_distance: float,
        sl_mult: float,
        tp_mult: float | None,
        *,
        entry_offset_bars: int = 0,
        be_trigger_r: float | None = None,
        max_bars_by_tf: dict[str, int] | None = None,
        optimistic: bool = False,
    ) -> tuple[ReplayResult, str | None]:
        """
        Прогон правила. sl_mult/tp_mult — в единицах исходного R.

        entry_offset_bars сдвигает вход на N свечей (плюс — позже, минус — раньше);
        цена входа тогда берётся по ОТКРЫТИЮ сдвинутой свечи, а стоп и тейк
        пересчитываются от неё — риск в абсолютных деньгах сохраняется.
        """
        if not np.isfinite(risk_distance) or risk_distance <= 0:
            return ReplayResult(UNDETERMINED, np.nan, 0, np.nan, False), None

        for tf, step in self.TIERS:
            arr = self.arrays.get((symbol, tf))
            if arr is None or arr["t"].size == 0:
                continue
            base_idx = find_bar_index(arr["t"], opened_ms, step)
            if base_idx is None:
                continue

            start_idx = base_idx + entry_offset_bars
            if start_idx < 0 or start_idx >= arr["t"].size:
                continue

            if entry_offset_bars == 0:
                eff_entry = float(entry_price)
            else:
                eff_entry = float(arr["o"][start_idx])
            if not np.isfinite(eff_entry) or eff_entry <= 0:
                continue

            sign = 1.0 if side == "long" else -1.0
            sl_price = eff_entry - sign * sl_mult * risk_distance
            tp_price = (
                None if tp_mult is None else eff_entry + sign * tp_mult * risk_distance
            )
            max_bars = None if max_bars_by_tf is None else max_bars_by_tf.get(tf)

            res = replay(
                arr["h"], arr["l"], arr["c"], start_idx, side,
                eff_entry, sl_price, tp_price, risk_distance,
                be_trigger_r=be_trigger_r, max_bars=max_bars, optimistic=optimistic,
            )
            if res.outcome != UNDETERMINED:
                return res, tf

        return ReplayResult(UNDETERMINED, np.nan, 0, np.nan, False), None

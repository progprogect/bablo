"""
Генератор синтетической выгрузки — точная копия формата боевых CSV.

Зачем: проверить весь пайплайн ДО того, как появятся реальные данные, и убедиться,
что он (а) находит зависимость, которую в данные заложили намеренно, и (б) не
выдумывает зависимостей там, где их нет.

В данные зашит один настоящий эффект: чем дальше рынок УЖЕ прошёл в сторону сделки
к моменту входа (RSI(14) на 15м, развёрнутый по направлению), тем хуже последующий
снос цены. Эффект непрерывный и умеренный — порядка ±1R на горизонте сделки, а не
приговор. Всё остальное — шум. Рабочий пайплайн обязан найти именно RSI(15м) и не
найти ничего постороннего.

Запуск: python3 analysis/make_synthetic.py [выходная-папка] [кол-во сделок]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

STEP_5M = 5 * 60_000
SYMBOLS = [("BTC-USDT", 60000.0), ("ETH-USDT", 3000.0), ("SOL-USDT", 150.0)]


def rsi(closes: np.ndarray, period: int = 14) -> np.ndarray:
    out = np.full(closes.size, np.nan)
    if closes.size <= period:
        return out
    delta = np.diff(closes)
    gain = np.where(delta > 0, delta, 0.0)
    loss = np.where(delta < 0, -delta, 0.0)
    ag, al = gain[:period].mean(), loss[:period].mean()
    out[period] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(period, delta.size):
        ag = (ag * (period - 1) + gain[i]) / period
        al = (al * (period - 1) + loss[i]) / period
        out[i + 1] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def ema(values: np.ndarray, period: int) -> np.ndarray:
    out = np.full(values.size, np.nan)
    if values.size < period:
        return out
    seed = values[:period].mean()
    out[period - 1] = seed
    k = 2 / (period + 1)
    for i in range(period, values.size):
        seed = values[i] * k + seed * (1 - k)
        out[i] = seed
    return out


def atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    out = np.full(close.size, np.nan)
    if close.size <= period:
        return out
    tr = np.maximum(high[1:] - low[1:], np.maximum(np.abs(high[1:] - close[:-1]), np.abs(low[1:] - close[:-1])))
    a = tr[:period].mean()
    out[period] = a
    for i in range(period, tr.size):
        a = (a * (period - 1) + tr[i]) / period
        out[i + 1] = a
    return out


def build_series(rng, base_price: float, n_bars: int) -> pd.DataFrame:
    """5м-серия случайного блуждания со скачками волатильности."""
    vol = base_price * 0.0012 * (1 + 0.5 * np.abs(rng.standard_normal(n_bars)).cumsum() / n_bars)
    steps = rng.standard_normal(n_bars) * vol
    close = base_price + np.cumsum(steps)
    close = np.maximum(close, base_price * 0.3)
    return pd.DataFrame({"close": close, "vol_scale": vol})


def ohlc_from_close(rng, close: np.ndarray, vol: np.ndarray) -> pd.DataFrame:
    open_ = np.concatenate([[close[0]], close[:-1]])
    wick_up = np.abs(rng.standard_normal(close.size)) * vol * 0.8
    wick_dn = np.abs(rng.standard_normal(close.size)) * vol * 0.8
    high = np.maximum(open_, close) + wick_up
    low = np.minimum(open_, close) - wick_dn
    volume = np.abs(rng.standard_normal(close.size)) * 1000 + 500
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": volume})


def resample(df5: pd.DataFrame, t_ms: np.ndarray, factor: int):
    """5м -> 15м (factor=3) / 1ч (factor=12)."""
    n = (df5.shape[0] // factor) * factor
    idx = np.arange(n).reshape(-1, factor)
    return pd.DataFrame({
        "t_ms": t_ms[: n : factor],
        "open": df5["open"].to_numpy()[idx][:, 0],
        "high": df5["high"].to_numpy()[idx].max(axis=1),
        "low": df5["low"].to_numpy()[idx].min(axis=1),
        "close": df5["close"].to_numpy()[idx][:, -1],
        "volume": df5["volume"].to_numpy()[idx].sum(axis=1),
    })


def snapshot_payload(rng, c15: pd.DataFrame, idx: int, c5: pd.DataFrame, i5: int) -> dict:
    """Payload в формате journal_trade_metrics (часть полей null — как в бою)."""
    def snap(df: pd.DataFrame, i: int) -> dict | None:
        if i < 210:
            return None
        cl = df["close"].to_numpy()
        hi, lo = df["high"].to_numpy(), df["low"].to_numpy()
        r = rsi(cl[: i + 1])[i]
        e21, e50, e200 = ema(cl[: i + 1], 21)[i], ema(cl[: i + 1], 50)[i], ema(cl[: i + 1], 200)[i]
        a = atr(hi[: i + 1], lo[: i + 1], cl[: i + 1])[i]
        close = cl[i]
        win = cl[max(0, i - 19) : i + 1]
        don_h, don_l = hi[max(0, i - 19) : i + 1].max(), lo[max(0, i - 19) : i + 1].min()
        return {
            "candleTime": int(df["t_ms"].to_numpy()[i]),
            "close": float(close),
            "rsi14": None if np.isnan(r) else float(r),
            "ema9": float(ema(cl[: i + 1], 9)[i]),
            "ema21": float(e21), "ema50": float(e50), "ema200": float(e200),
            "priceToEma21Pct": float((close - e21) / e21 * 100),
            "priceToEma50Pct": float((close - e50) / e50 * 100),
            "priceToEma200Pct": float((close - e200) / e200 * 100),
            "atr14": float(a), "atrPct": float(a / close * 100),
            "macd": {"line": float(ema(cl[: i + 1], 12)[i] - ema(cl[: i + 1], 26)[i]),
                     "signal": float(rng.normal(0, a * 0.1)), "histogram": float(rng.normal(0, a * 0.1))},
            "bollinger": {"upper": float(win.mean() + 2 * win.std()), "middle": float(win.mean()),
                          "lower": float(win.mean() - 2 * win.std()),
                          "percentB": float(np.clip((close - (win.mean() - 2 * win.std())) / max(4 * win.std(), 1e-9), -1, 2)),
                          "bandwidthPct": float(4 * win.std() / win.mean() * 100)},
            "volumeRatio20": float(df["volume"].to_numpy()[i] / max(df["volume"].to_numpy()[max(0, i - 19) : i + 1].mean(), 1e-9)),
            "stochastic14": {"k": float(np.clip((close - don_l) / max(don_h - don_l, 1e-9) * 100, 0, 100)),
                             "d": float(rng.uniform(0, 100))},
            "williamsR14": float(-np.clip((don_h - close) / max(don_h - don_l, 1e-9) * 100, 0, 100)),
            "cci20": float(rng.normal(0, 100)),
            "adx14": {"adx": float(rng.uniform(10, 45)), "plusDi": float(rng.uniform(10, 35)), "minusDi": float(rng.uniform(10, 35))},
            "donchian20": {"high": float(don_h), "low": float(don_l),
                           "positionPct": float(np.clip((close - don_l) / max(don_h - don_l, 1e-9) * 100, 0, 100))},
            "dayVwap": float(win.mean()), "priceToVwapPct": float((close - win.mean()) / win.mean() * 100),
            "candleAnatomy": {"bodyAtr": float(abs(close - df["open"].to_numpy()[i]) / max(a, 1e-9)),
                              "upperWickAtr": float((hi[i] - max(close, df["open"].to_numpy()[i])) / max(a, 1e-9)),
                              "lowerWickAtr": float((min(close, df["open"].to_numpy()[i]) - lo[i]) / max(a, 1e-9))},
        }

    return {
        "version": 2,
        "atEntry": {"5m": snap(c5, i5), "15m": snap(c15, idx), "1h": None},
        "excursions": {"maeR": None, "mfeRFromCandles": None},
        "structure": {
            "levels": [{"price": float(c15["close"].to_numpy()[idx]), "touches": 2, "kind": "high"}],
            "lastBosBeforeEntry": {"direction": rng.choice(["up", "down"]), "price": float(c15["close"].to_numpy()[idx]),
                                   "time": int(c15["t_ms"].to_numpy()[idx]), "candlesAgo": int(rng.integers(1, 40))},
            "entryInsideZone": bool(rng.random() < 0.3),
            "lastEngulfingBeforeEntry": {"direction": rng.choice(["bull", "bear"]), "candlesAgo": int(rng.integers(1, 30))},
        },
    }


def main() -> None:
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "data/synthetic")
    n_trades = int(sys.argv[2]) if len(sys.argv) > 2 else 120
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(42)

    start_ms = int(pd.Timestamp("2026-03-01T00:00:00Z").value // 1_000_000)
    n_bars = 9000  # ~31 день по 5м

    candle_rows, trade_rows, metric_rows, sync_rows = [], [], [], []
    trade_id = 0
    per_symbol_trades = max(1, n_trades // len(SYMBOLS))

    for symbol, base in SYMBOLS:
        series = build_series(rng, base, n_bars)
        close = series["close"].to_numpy().copy()
        vol = series["vol_scale"].to_numpy()
        t5 = start_ms + np.arange(n_bars) * STEP_5M

        # Выбираем точки входа и закладываем зависимость от RSI(15м)
        entry_idxs = np.sort(rng.choice(np.arange(2600, n_bars - 500), size=per_symbol_trades, replace=False))
        planned = []
        for i5 in entry_idxs:
            side = "long" if rng.random() < 0.5 else "short"
            i15 = i5 // 3
            c15_close = close[: i5 + 1][::3]
            r = rsi(c15_close)[-1] if c15_close.size > 20 else 50.0
            r = 50.0 if np.isnan(r) else r
            # ЗАЛОЖЕННЫЙ ЭФФЕКТ: чем дальше рынок УЖЕ прошёл в сторону сделки
            # (RSI, развёрнутый по направлению), тем хуже последующий снос.
            # Непрерывный и умеренный: ~±1R на горизонте сделки, а не приговор.
            r_dir = r if side == "long" else 100.0 - r
            drift = -0.008 * (r_dir - 45.0)
            planned.append((i5, side, drift))
            # Применяем снос к последующему участку
            seg = slice(i5 + 1, min(i5 + 140, n_bars))
            close[seg] += np.cumsum(np.full(close[seg].shape, drift * vol[seg] * 0.30)) * (1 if side == "long" else -1)

        ohlc = ohlc_from_close(rng, close, vol)
        ohlc["t_ms"] = t5
        c15 = resample(ohlc, t5, 3)
        c1h = resample(ohlc, t5, 12)

        for tf, df in (("5m", ohlc[["t_ms", "open", "high", "low", "close", "volume"]]), ("15m", c15), ("1h", c1h)):
            d = df.copy()
            d["symbol"], d["interval"] = symbol, tf
            candle_rows.append(d)

        hi, lo = ohlc["high"].to_numpy(), ohlc["low"].to_numpy()
        for i5, side, _ in planned:
            trade_id += 1
            entry = float(ohlc["close"].to_numpy()[i5])
            a = atr(hi[: i5 + 1], lo[: i5 + 1], close[: i5 + 1])[i5]
            if not np.isfinite(a) or a <= 0:
                a = entry * 0.003
            risk_dist = float(a * rng.uniform(0.8, 1.6))
            rr = float(rng.choice([2.0, 3.0, 2.0, 1.5]))
            sign = 1.0 if side == "long" else -1.0
            sl = entry - sign * risk_dist
            tp = entry + sign * rr * risk_dist
            qty = round(rng.uniform(20, 120) / entry * 100, 6)
            risk_usd = round(risk_dist * qty, 2)

            # Исход определяем реплеем по СГЕНЕРИРОВАННЫМ свечам — полная согласованность
            outcome, exit_px, exit_i = "open", np.nan, None
            best = entry
            for j in range(i5, min(i5 + 400, n_bars)):
                best = max(best, hi[j]) if side == "long" else min(best, lo[j])
                hit_sl = lo[j] <= sl if side == "long" else hi[j] >= sl
                hit_tp = hi[j] >= tp if side == "long" else lo[j] <= tp
                if hit_sl:  # пессимистично: стоп вперёд
                    outcome, exit_px, exit_i = "sl", sl, j
                    break
                if hit_tp:
                    outcome, exit_px, exit_i = "tp", tp, j
                    break
            if exit_i is None:
                outcome, exit_px, exit_i = "manual", float(ohlc["close"].to_numpy()[min(i5 + 399, n_bars - 1)]), min(i5 + 399, n_bars - 1)

            result_r = sign * (exit_px - entry) / risk_dist
            opened = pd.Timestamp(t5[i5], unit="ms", tz="UTC")
            closed = pd.Timestamp(t5[exit_i], unit="ms", tz="UTC")

            trade_rows.append({
                "id": trade_id, "symbol": symbol, "side": side, "status": "closed",
                "quantity": qty, "leverage": int(rng.choice([5, 10, 20])),
                "entry_price": entry, "sl_price": sl, "tp_price": tp, "tp_price_initial": tp,
                "rr_preset": f"1/{rr:g}", "risk_usd": risk_usd,
                "partial_tp_price": None, "partial_tp_percent": None, "partial_tp_quantity": None,
                "partial_tp_filled_at": None, "partial_tp_fill_price": None,
                "night_tp_applied_at": None, "trail_sl_applied_r": None,
                "stats_rr_preset": None, "stats_outcome": None,
                "opened_at": opened.isoformat(), "closed_at": closed.isoformat(),
                "close_reason": outcome, "close_price": exit_px,
                "result_r": round(result_r, 4), "result_pct": round(result_r * 2, 4),
                "mfe_price": best, "be_crossed": bool(rng.random() < 0.4),
                "bingx_order_ids": "{}", "signals": None,
            })
            metric_rows.append({
                "trade_id": trade_id, "version": 2,
                "computed_at": closed.isoformat(),
                "payload": json.dumps(snapshot_payload(rng, c15, i5 // 3, ohlc.assign(t_ms=t5), i5)),
            })
            for tf in ("5m", "15m", "1h"):
                sync_rows.append({
                    "id": len(sync_rows) + 1, "trade_id": trade_id, "interval": tf,
                    "from_time": opened.isoformat(), "to_time": closed.isoformat(),
                    "candles_fetched": 300, "fetched_at": closed.isoformat(),
                })

    # --- Запись CSV ---
    pd.DataFrame(trade_rows).to_csv(out_dir / "trades.csv", index=False)
    pd.DataFrame(metric_rows).to_csv(out_dir / "journal_trade_metrics.csv", index=False)
    pd.DataFrame(sync_rows).to_csv(out_dir / "journal_candle_syncs.csv", index=False)

    candles = pd.concat(candle_rows, ignore_index=True)
    candles["open_time"] = pd.to_datetime(candles["t_ms"], unit="ms", utc=True).map(lambda x: x.isoformat())
    candles[["symbol", "interval", "open_time", "open", "high", "low", "close", "volume"]].to_csv(
        out_dir / "journal_candles.csv", index=False)

    # Журнал разбора: две категории, чек-лист, ответы (частично — как в жизни)
    cats = pd.DataFrame([{"id": 1, "name": "Пробой уровня", "sort_order": 0, "archived_at": None, "created_at": "2026-03-01T00:00:00Z"},
                         {"id": 2, "name": "Откат в тренде", "sort_order": 1, "archived_at": None, "created_at": "2026-03-01T00:00:00Z"}])
    items = pd.DataFrame([
        {"id": 1, "category_id": 1, "label": "Был ли объём на пробое", "answer_type": "yes_no", "options": None, "sort_order": 0, "archived_at": None, "created_at": "2026-03-01T00:00:00Z"},
        {"id": 2, "category_id": 1, "label": "Качество входа", "answer_type": "scale_0_10", "options": None, "sort_order": 1, "archived_at": None, "created_at": "2026-03-01T00:00:00Z"},
        {"id": 3, "category_id": 2, "label": "Тренд подтверждён", "answer_type": "yes_no", "options": None, "sort_order": 0, "archived_at": None, "created_at": "2026-03-01T00:00:00Z"},
        {"id": 4, "category_id": 2, "label": "Эмоции", "answer_type": "choice", "options": '["спокоен","спешка","тильт"]', "sort_order": 1, "archived_at": None, "created_at": "2026-03-01T00:00:00Z"},
    ])
    entries, answers = [], []
    for tid in range(1, trade_id + 1):
        if rng.random() < 0.7:  # не все сделки разобраны
            cid = int(rng.choice([1, 2]))
            eid = len(entries) + 1
            entries.append({"id": eid, "trade_id": tid, "category_id": cid,
                            "categorized_at": "2026-04-01T00:00:00Z", "updated_at": "2026-04-01T00:00:00Z"})
            for it in items[items["category_id"] == cid].itertuples():
                row = {"id": len(answers) + 1, "entry_id": eid, "item_id": it.id,
                       "value_bool": None, "value_int": None, "value_text": None}
                if it.answer_type == "yes_no":
                    row["value_bool"] = bool(rng.random() < 0.5)
                elif it.answer_type == "scale_0_10":
                    row["value_int"] = int(rng.integers(0, 11))
                else:
                    row["value_text"] = str(rng.choice(["спокоен", "спешка", "тильт"]))
                answers.append(row)

    cats.to_csv(out_dir / "journal_categories.csv", index=False)
    items.to_csv(out_dir / "journal_checklist_items.csv", index=False)
    pd.DataFrame(entries).to_csv(out_dir / "journal_entries.csv", index=False)
    pd.DataFrame(answers).to_csv(out_dir / "journal_answers.csv", index=False)
    for name in ("daily_stats", "risk_levels", "equity_snapshots", "hour_blocks", "assets"):
        pd.DataFrame().to_csv(out_dir / f"{name}.csv", index=False)

    td = pd.DataFrame(trade_rows)
    print(f"Синтетика в {out_dir}: {trade_id} сделок, {len(candles)} свечей")
    print(f"  Исходы: {td['close_reason'].value_counts().to_dict()}")
    print("  ЗАЛОЖЕННЫЙ ЭФФЕКТ: чем выше RSI(15м) по направлению сделки, тем хуже снос.")
    print("  Пайплайн обязан найти 15m.rsi14_dir и НЕ найти ничего постороннего.")


if __name__ == "__main__":
    main()

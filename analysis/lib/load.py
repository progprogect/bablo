"""
Загрузка выгрузки БД в аккуратные таблицы.

Логика исхода и геометрии сделки — ПОРТ продуктового кода, не переизобретение:
  * outcome           -> server/src/history/outcome.ts  (resolveTradeOutcome)
  * risk_distance     -> server/src/journal/logic.ts    (entryRiskDistance)
  * initial_sl        -> server/src/journal/logic.ts    (initialSlPrice)
  * planned_rr        -> server/src/journal/logic.ts    (plannedRR)

Это важно: в trades.sl_price лежит ТЕКУЩИЙ стоп, подвинутый трейлингом и ночным
правилом. Для анализа «каким был план» он не годится — нужен стоп при входе,
восстановленный из risk_usd / quantity.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

BREAKEVEN_EPSILON_R = 0.05
INTERVALS = ("5m", "15m", "1h")
STEP_MS = {"5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000}

TABLES = [
    "trades",
    "journal_entries",
    "journal_categories",
    "journal_checklist_items",
    "journal_answers",
    "journal_trade_metrics",
    "journal_candles",
    "journal_candle_syncs",
    "daily_stats",
    "risk_levels",
    "equity_snapshots",
    "hour_blocks",
    "assets",
]


def load_raw(raw_dir: str | Path) -> dict[str, pd.DataFrame]:
    """Читает CSV выгрузки. Отсутствующие таблицы -> пустой DataFrame (не падаем)."""
    raw_dir = Path(raw_dir)
    out: dict[str, pd.DataFrame] = {}
    for name in TABLES:
        path = raw_dir / f"{name}.csv"
        out[name] = pd.DataFrame()
        if not path.exists() or path.stat().st_size == 0:
            continue
        try:
            out[name] = pd.read_csv(path)
        except pd.errors.EmptyDataError:
            # Пустая таблица: файл есть, колонок нет. Это не ошибка выгрузки.
            pass
    return out


def to_epoch_ms(series: pd.Series) -> np.ndarray:
    """
    Время в миллисекундах эпохи — независимо от разрешения datetime64.

    ВАЖНО: .astype("int64") на дате отдаёт число в СОБСТВЕННОМ разрешении колонки
    (s / ms / us / ns), которое pandas выбирает сам при парсинге. Полагаться на
    наносекунды нельзя: ISO-строки без долей секунды парсятся в микросекунды, и
    деление на 1e6 молча даёт секунды вместо миллисекунд. Ошибка не роняет код —
    она тихо ломает сравнения времени, поэтому разрешение задаём явно.
    """
    dt = pd.to_datetime(series, utc=True, errors="coerce")
    return dt.dt.tz_localize(None).to_numpy(dtype="datetime64[ms]").astype("int64")


def _num(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce")


def _ts(series: pd.Series) -> pd.Series:
    return pd.to_datetime(series, utc=True, errors="coerce", format="mixed")


# --- Порт продуктовой логики -------------------------------------------------------------


def entry_risk_distance(risk_usd, quantity, entry_price, sl_price) -> float:
    """Дистанция 1R, с которой ВОШЛИ. risk_usd/qty — основной путь, |entry-sl| — запасной."""
    if pd.notna(risk_usd) and pd.notna(quantity) and risk_usd > 0 and quantity > 0:
        return float(risk_usd) / float(quantity)
    if pd.isna(entry_price) or pd.isna(sl_price):
        return np.nan
    distance = abs(float(entry_price) - float(sl_price))
    return distance if distance > 0 else np.nan


def resolve_outcome(close_reason, entry_price, sl_price, side, stats_outcome, result_r) -> str:
    """Порт resolveTradeOutcome: исход по ЭКОНОМИКЕ, а не по типу сработавшего ордера."""
    if isinstance(stats_outcome, str) and stats_outcome in ("tp", "sl", "be"):
        return stats_outcome
    if pd.isna(result_r):
        return "other"
    r = float(result_r)

    # isBreakevenClose
    if abs(r) <= BREAKEVEN_EPSILON_R:
        if close_reason != "sl":
            return "be"
        if pd.notna(entry_price) and pd.notna(sl_price) and side in ("long", "short"):
            on_profit_side = (
                float(sl_price) >= float(entry_price)
                if side == "long"
                else float(sl_price) <= float(entry_price)
            )
            if on_profit_side:
                return "be"
        else:
            return "be"

    if close_reason == "tp":
        return "tp"
    if close_reason == "sl":
        # isProfitLockedStop: стоп с положительным R = зафиксированная прибыль
        return "tp" if r > BREAKEVEN_EPSILON_R else "sl"
    return "other"


# --- Сборка таблицы сделок ---------------------------------------------------------------


def build_trades(raw: dict[str, pd.DataFrame], tz_offset_hours: float = 3.0) -> pd.DataFrame:
    """
    Закрытые сделки с восстановленной геометрией входа и исходом.

    tz_offset_hours — часовой пояс риск-плана (по умолчанию МСК, UTC+3): в нём
    считаются «час входа» и «день недели», как в history/insights.ts.
    """
    t = raw["trades"].copy()
    if t.empty:
        return t

    for col in (
        "quantity", "entry_price", "sl_price", "tp_price", "tp_price_initial",
        "risk_usd", "result_r", "result_pct", "mfe_price", "leverage",
        "partial_tp_price", "partial_tp_percent",
    ):
        if col in t.columns:
            t[col] = _num(t[col])
    for col in ("opened_at", "closed_at", "partial_tp_filled_at", "night_tp_applied_at"):
        if col in t.columns:
            t[col] = _ts(t[col])

    t = t[t["status"] == "closed"].copy()

    t["risk_distance"] = [
        entry_risk_distance(r.risk_usd, r.quantity, r.entry_price, r.sl_price)
        for r in t.itertuples()
    ]
    t["initial_sl"] = np.where(
        t["side"] == "long",
        t["entry_price"] - t["risk_distance"],
        t["entry_price"] + t["risk_distance"],
    )
    t["planned_rr"] = (t["tp_price_initial"] - t["entry_price"]).abs() / t["risk_distance"]
    t["outcome"] = [
        resolve_outcome(
            r.close_reason, r.entry_price, r.sl_price, r.side,
            getattr(r, "stats_outcome", None), r.result_r,
        )
        for r in t.itertuples()
    ]
    # MFE трекера в R от исходного риска
    move = np.where(
        t["side"] == "long",
        t["mfe_price"] - t["entry_price"],
        t["entry_price"] - t["mfe_price"],
    )
    t["mfe_r_tracker"] = move / t["risk_distance"]

    local = t["opened_at"] + pd.Timedelta(hours=tz_offset_hours)
    t["hour"] = local.dt.hour
    t["dow"] = local.dt.dayofweek
    t["local_date"] = local.dt.date
    t["duration_min"] = (t["closed_at"] - t["opened_at"]).dt.total_seconds() / 60.0

    # Частичная фиксация состоялась — сделка нетипична, помечаем
    t["had_partial"] = t["partial_tp_filled_at"].notna() if "partial_tp_filled_at" in t else False
    t["night_tp"] = t["night_tp_applied_at"].notna() if "night_tp_applied_at" in t else False

    return t.sort_values("opened_at").reset_index(drop=True)


# --- Развёртка снапшота индикаторов в признаки -------------------------------------------


def _flatten_snapshot(snap: dict | None, prefix: str) -> dict:
    """
    IndicatorSnapshot -> плоские признаки. Берём ТОЛЬКО нормированные величины.

    Абсолютные ценовые уровни (close, ema9/21/50/200, atr14, dayVwap, границы
    Боллинджера и Дончиана) сюда НЕ попадают намеренно: это цена BTC против цены
    ETH против цены SOL. В сравнении «тейки против стопов» такой признак покажет
    красивую разницу, которая означает лишь «символы разные» — и это самый лёгкий
    способ принять артефакт за закономерность. MACD переводим в доли ATR по той же
    причине: сам по себе он в единицах цены.
    """
    out: dict[str, float] = {}
    if not isinstance(snap, dict):
        return out

    # Уже нормированные — берём как есть
    for k in ("rsi14", "priceToEma21Pct", "priceToEma50Pct", "priceToEma200Pct",
              "atrPct", "volumeRatio20", "williamsR14", "cci20", "priceToVwapPct"):
        v = snap.get(k)
        if isinstance(v, (int, float)):
            out[f"{prefix}.{k}"] = float(v)

    atr = snap.get("atr14")
    atr = float(atr) if isinstance(atr, (int, float)) and atr > 0 else None
    if atr:
        # Служебное: нужно, чтобы выразить риск сделки в ATR. Из признаков удаляется.
        out[f"{prefix}._atr14"] = atr

    macd = snap.get("macd")
    if isinstance(macd, dict) and atr:
        for k, name in (("line", "macd_line_atr"), ("histogram", "macd_hist_atr")):
            if isinstance(macd.get(k), (int, float)):
                out[f"{prefix}.{name}"] = float(macd[k]) / atr

    bb = snap.get("bollinger")
    if isinstance(bb, dict):
        for k in ("percentB", "bandwidthPct"):
            if isinstance(bb.get(k), (int, float)):
                out[f"{prefix}.bb_{k}"] = float(bb[k])

    st = snap.get("stochastic14")
    if isinstance(st, dict):
        for k in ("k", "d"):
            if isinstance(st.get(k), (int, float)):
                out[f"{prefix}.stoch_{k}"] = float(st[k])

    adx = snap.get("adx14")
    if isinstance(adx, dict):
        for k in ("adx", "plusDi", "minusDi"):
            if isinstance(adx.get(k), (int, float)):
                out[f"{prefix}.adx_{k}"] = float(adx[k])

    don = snap.get("donchian20")
    if isinstance(don, dict) and isinstance(don.get("positionPct"), (int, float)):
        out[f"{prefix}.donchian_positionPct"] = float(don["positionPct"])

    anat = snap.get("candleAnatomy")
    if isinstance(anat, dict):
        for k in ("bodyAtr", "upperWickAtr", "lowerWickAtr"):
            if isinstance(anat.get(k), (int, float)):
                out[f"{prefix}.candle_{k}"] = float(anat[k])

    return out


def _flatten_structure(struct: dict | None) -> dict:
    out: dict[str, float] = {}
    if not isinstance(struct, dict):
        return out
    out["struct.entryInsideZone"] = 1.0 if struct.get("entryInsideZone") else 0.0

    bos = struct.get("lastBosBeforeEntry")
    if isinstance(bos, dict):
        if isinstance(bos.get("candlesAgo"), (int, float)):
            out["struct.bosCandlesAgo"] = float(bos["candlesAgo"])
        direction = bos.get("direction")
        if direction in ("up", "down", "bull", "bear"):
            out["struct.bosUp"] = 1.0 if direction in ("up", "bull") else 0.0

    eng = struct.get("lastEngulfingBeforeEntry")
    if isinstance(eng, dict):
        if isinstance(eng.get("candlesAgo"), (int, float)):
            out["struct.engulfCandlesAgo"] = float(eng["candlesAgo"])
        if eng.get("direction") in ("bull", "bear"):
            out["struct.engulfBull"] = 1.0 if eng["direction"] == "bull" else 0.0

    levels = struct.get("levels")
    if isinstance(levels, list):
        out["struct.levelCount"] = float(len(levels))
    return out


def build_metrics_features(raw: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """journal_trade_metrics.payload -> широкая матрица признаков, индекс trade_id."""
    m = raw["journal_trade_metrics"]
    if m.empty:
        return pd.DataFrame()

    rows = []
    for rec in m.itertuples():
        try:
            payload = json.loads(rec.payload) if isinstance(rec.payload, str) else rec.payload
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(payload, dict):
            continue

        row: dict = {"trade_id": int(rec.trade_id), "metrics_version": payload.get("version")}
        at_entry = payload.get("atEntry") or {}
        for interval in INTERVALS:
            row.update(_flatten_snapshot(at_entry.get(interval), interval))

        exc = payload.get("excursions") or {}
        for key, name in (("maeR", "exc.maeR"), ("mfeRFromCandles", "exc.mfeR")):
            v = exc.get(key)
            if isinstance(v, (int, float)):
                row[name] = float(v)

        row.update(_flatten_structure(payload.get("structure")))
        rows.append(row)

    if not rows:
        return pd.DataFrame()
    return pd.DataFrame(rows).set_index("trade_id")


def build_answer_features(raw: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Ответы чек-листа -> признаки, индекс trade_id. Колонка на пункт."""
    entries, answers, items = (
        raw["journal_entries"], raw["journal_answers"], raw["journal_checklist_items"]
    )
    if entries.empty or answers.empty or items.empty:
        return pd.DataFrame()

    cats = raw["journal_categories"]
    item_map = items.set_index("id")
    merged = answers.merge(
        entries[["id", "trade_id", "category_id"]],
        left_on="entry_id", right_on="id", suffixes=("", "_entry"),
    )

    rows: dict[int, dict] = {}
    for rec in merged.itertuples():
        trade_id = int(rec.trade_id)
        rows.setdefault(trade_id, {"trade_id": trade_id, "category_id": rec.category_id})
        if rec.item_id not in item_map.index:
            continue
        item = item_map.loc[rec.item_id]
        label = str(item["label"]).strip().replace(" ", "_")[:40]
        col = f"ans.{rec.item_id}.{label}"

        if pd.notna(rec.value_bool):
            rows[trade_id][col] = 1.0 if bool(rec.value_bool) else 0.0
        elif pd.notna(rec.value_int):
            rows[trade_id][col] = float(rec.value_int)
        elif pd.notna(rec.value_text):
            rows[trade_id][f"{col}__txt"] = str(rec.value_text)

    df = pd.DataFrame(list(rows.values()))
    if df.empty:
        return df
    if not cats.empty:
        name_by_id = dict(zip(cats["id"], cats["name"]))
        df["category"] = df["category_id"].map(name_by_id)
    return df.set_index("trade_id")


def build_candles(raw: dict[str, pd.DataFrame]) -> dict[tuple[str, str], pd.DataFrame]:
    """Свечи, сгруппированные по (symbol, interval), отсортированные по времени."""
    c = raw["journal_candles"]
    if c.empty:
        return {}
    c = c.copy()
    c["open_time"] = _ts(c["open_time"])
    for col in ("open", "high", "low", "close", "volume"):
        c[col] = _num(c[col])
    c["t_ms"] = to_epoch_ms(c["open_time"])

    out: dict[tuple[str, str], pd.DataFrame] = {}
    for (symbol, interval), group in c.groupby(["symbol", "interval"], sort=False):
        out[(symbol, interval)] = (
            group.sort_values("t_ms")
            .reset_index(drop=True)[["t_ms", "open", "high", "low", "close", "volume"]]
        )
    return out



# --- Разворот признаков по направлению сделки --------------------------------------------
#
# Зачем: почти все осцилляторы направленные. Перекупленность (RSI 75) опасна для лонга
# и безобидна для шорта. Если сравнивать RSI «в общей куче», эффект лонгов и эффект
# шортов взаимно гасятся, и настоящая зависимость становится невидимой.
#
# Поэтому для каждого направленного индикатора строится версия «_dir», развёрнутая
# так, что смысл одинаков для лонга и шорта:
#   высокое значение = рынок УЖЕ прошёл в сторону сделки (вход поздний, в растянутое
#   движение); низкое = вход против движения / рано.

# Шкала 0..100, разворот 100-v
_FLIP_100 = ("rsi14", "stoch_k", "stoch_d", "donchian_positionPct")
# Шкала 0..1, разворот 1-v
_FLIP_1 = ("bb_percentB",)
# Симметричные вокруг нуля, разворот -v
_FLIP_SIGN = ("cci20", "priceToEma21Pct", "priceToEma50Pct", "priceToEma200Pct",
              "priceToVwapPct", "macd_line_atr", "macd_hist_atr")


def add_oriented_features(feats: pd.DataFrame) -> pd.DataFrame:
    """Добавляет признаки «_dir», развёрнутые по стороне сделки."""
    if feats.empty or "side" not in feats.columns:
        return feats
    is_short = (feats["side"] == "short").to_numpy()
    new: dict[str, np.ndarray] = {}

    for interval in INTERVALS:
        def col(name: str):
            c = f"{interval}.{name}"
            return pd.to_numeric(feats[c], errors="coerce").to_numpy(dtype=float) if c in feats.columns else None

        for name in _FLIP_100:
            v = col(name)
            if v is not None:
                new[f"{interval}.{name}_dir"] = np.where(is_short, 100.0 - v, v)
        for name in _FLIP_1:
            v = col(name)
            if v is not None:
                new[f"{interval}.{name}_dir"] = np.where(is_short, 1.0 - v, v)
        for name in _FLIP_SIGN:
            v = col(name)
            if v is not None:
                new[f"{interval}.{name}_dir"] = np.where(is_short, -v, v)

        # Williams %R живёт в -100..0: разворот -100 - v
        wr = col("williamsR14")
        if wr is not None:
            new[f"{interval}.williamsR14_dir"] = np.where(is_short, -100.0 - wr, wr)

        # Directional Index: «по сделке» и «против сделки» вместо plus/minus
        plus, minus = col("adx_plusDi"), col("adx_minusDi")
        if plus is not None and minus is not None:
            di_with = np.where(is_short, minus, plus)
            di_against = np.where(is_short, plus, minus)
            new[f"{interval}.adx_di_with"] = di_with
            new[f"{interval}.adx_di_against"] = di_against
            new[f"{interval}.adx_di_spread"] = di_with - di_against

        # Тень против позиции — это отказ цены идти в нужную сторону
        up, dn = col("candle_upperWickAtr"), col("candle_lowerWickAtr")
        if up is not None and dn is not None:
            new[f"{interval}.candle_wick_against"] = np.where(is_short, dn, up)
            new[f"{interval}.candle_wick_with"] = np.where(is_short, up, dn)

    # Слом структуры: по сделке или против неё
    if "struct.bosUp" in feats.columns:
        bos = pd.to_numeric(feats["struct.bosUp"], errors="coerce").to_numpy(dtype=float)
        new["struct.bos_with_trade"] = np.where(is_short, 1.0 - bos, bos)
    if "struct.engulfBull" in feats.columns:
        eng = pd.to_numeric(feats["struct.engulfBull"], errors="coerce").to_numpy(dtype=float)
        new["struct.engulf_with_trade"] = np.where(is_short, 1.0 - eng, eng)

    # Риск сделки в единицах ATR и в процентах цены — сопоставимо между символами
    if "risk_distance" in feats.columns and "entry_price" in feats.columns:
        rd = pd.to_numeric(feats["risk_distance"], errors="coerce").to_numpy(dtype=float)
        ep = pd.to_numeric(feats["entry_price"], errors="coerce").to_numpy(dtype=float)
        with np.errstate(divide="ignore", invalid="ignore"):
            new["risk_pct_of_price"] = rd / ep * 100.0
        for interval in INTERVALS:
            c = f"{interval}._atr14"
            if c in feats.columns:
                a = pd.to_numeric(feats[c], errors="coerce").to_numpy(dtype=float)
                with np.errstate(divide="ignore", invalid="ignore"):
                    new[f"risk_in_atr_{interval}"] = np.where(a > 0, rd / a, np.nan)

    out = pd.concat([feats, pd.DataFrame(new, index=feats.index)], axis=1)
    # Служебные абсолютные ATR больше не нужны
    return out.drop(columns=[c for c in out.columns if c.endswith("._atr14")])


def build_dataset(raw_dir: str | Path, tz_offset_hours: float = 3.0):
    """Единая точка входа: raw CSV -> (trades, features, candles, raw)."""
    raw = load_raw(raw_dir)
    trades = build_trades(raw, tz_offset_hours=tz_offset_hours)
    metrics = build_metrics_features(raw)
    answers = build_answer_features(raw)

    features = trades.set_index("id")
    if not metrics.empty:
        features = features.join(metrics, how="left")
    if not answers.empty:
        features = features.join(answers, how="left")

    features = add_oriented_features(features)
    return trades, features.reset_index().rename(columns={"index": "id"}), build_candles(raw), raw

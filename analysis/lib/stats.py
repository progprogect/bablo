"""
Статистика для поиска зависимостей — с защитой от самообмана.

Главная ловушка этой задачи: признаков ~80, сделок обычно десятки. При пороге
p<0.05 примерно каждый двадцатый признак покажется «значимым» на чистом шуме —
то есть 4 красивых ложных находки гарантированы ещё до начала анализа.

Поэтому здесь:
  * размер эффекта (Cliff's delta) рядом с каждым p — он не зависит от N и говорит,
    насколько РЕАЛЬНО расходятся распределения;
  * поправка Бенджамини-Хохберга (FDR) на всё семейство тестов;
  * проверка перестановками: сколько «значимых» признаков даёт та же процедура на
    случайно перемешанных метках. Если находок не больше, чем на шуме, — находок нет.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats


def cliffs_delta(a: np.ndarray, b: np.ndarray) -> float:
    """
    Размер эффекта для двух выборок: доля пар, где a>b, минус доля, где a<b.
    От -1 до +1, не зависит от N. |d|: 0.11 малый, 0.28 средний, 0.43 большой.
    """
    a = a[np.isfinite(a)]
    b = b[np.isfinite(b)]
    if a.size == 0 or b.size == 0:
        return np.nan
    # Через ранги — O(n log n) вместо попарного перебора
    combined = np.concatenate([a, b])
    ranks = stats.rankdata(combined)
    rank_a = ranks[: a.size].sum()
    u_a = rank_a - a.size * (a.size + 1) / 2.0
    return float(2.0 * u_a / (a.size * b.size) - 1.0)


def effect_label(d: float) -> str:
    if not np.isfinite(d):
        return "-"
    ad = abs(d)
    if ad < 0.11:
        return "ничтожный"
    if ad < 0.28:
        return "малый"
    if ad < 0.43:
        return "средний"
    return "большой"


def benjamini_hochberg(pvals: np.ndarray) -> np.ndarray:
    """FDR-поправка. Возвращает q-значения того же порядка, что и вход."""
    p = np.asarray(pvals, dtype=float)
    ok = np.isfinite(p)
    q = np.full(p.shape, np.nan)
    if ok.sum() == 0:
        return q
    pv = p[ok]
    n = pv.size
    order = np.argsort(pv)
    ranked = pv[order]
    adj = ranked * n / np.arange(1, n + 1)
    adj = np.minimum.accumulate(adj[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.clip(adj, 0, 1)
    q[ok] = out
    return q


def univariate_screen(
    df: pd.DataFrame, feature_cols: list[str], mask_a: pd.Series, mask_b: pd.Series,
    min_per_group: int = 5,
) -> pd.DataFrame:
    """
    Сравнение каждого признака между двумя группами (обычно тейки и стопы).

    Манна-Уитни (непараметрический — распределения индикаторов далеки от нормальных)
    + Cliff's delta + FDR. Признаки, где в группе меньше min_per_group значений,
    отбрасываются: на трёх наблюдениях «зависимости» не бывает.
    """
    rows = []
    for col in feature_cols:
        a = pd.to_numeric(df.loc[mask_a, col], errors="coerce").to_numpy(dtype=float)
        b = pd.to_numeric(df.loc[mask_b, col], errors="coerce").to_numpy(dtype=float)
        a = a[np.isfinite(a)]
        b = b[np.isfinite(b)]
        if a.size < min_per_group or b.size < min_per_group:
            continue
        if np.unique(np.concatenate([a, b])).size < 2:
            continue
        try:
            _, p = stats.mannwhitneyu(a, b, alternative="two-sided")
        except ValueError:
            continue
        rows.append({
            "feature": col,
            "n_a": a.size, "n_b": b.size,
            "median_a": float(np.median(a)), "median_b": float(np.median(b)),
            "delta": cliffs_delta(a, b),
            "p": float(p),
        })

    if not rows:
        return pd.DataFrame(columns=["feature", "n_a", "n_b", "median_a", "median_b", "delta", "p", "q", "effect"])

    out = pd.DataFrame(rows)
    out["q"] = benjamini_hochberg(out["p"].to_numpy())
    out["effect"] = out["delta"].map(effect_label)
    return out.sort_values("p").reset_index(drop=True)


def permutation_null(
    df: pd.DataFrame, feature_cols: list[str], labels: pd.Series,
    n_perm: int = 200, alpha: float = 0.05, seed: int = 17,
) -> dict:
    """
    Сколько «значимых» признаков даёт та же процедура на перемешанных метках.

    Это честная точка отсчёта: если на реальных метках находок столько же, сколько
    на случайных, значит вся «структура» — артефакт множественных сравнений.
    """
    rng = np.random.default_rng(seed)
    y = labels.to_numpy().copy()
    counts = []
    for _ in range(n_perm):
        shuffled = pd.Series(rng.permutation(y), index=labels.index)
        res = univariate_screen(df, feature_cols, shuffled == 1, shuffled == 0)
        counts.append(0 if res.empty else int((res["p"] < alpha).sum()))
    counts = np.array(counts)
    return {
        "mean": float(counts.mean()),
        "p95": float(np.percentile(counts, 95)),
        "max": int(counts.max()),
        "counts": counts,
    }


def wilson_interval(successes: int, total: int, z: float = 1.96) -> tuple[float, float]:
    """
    Доверительный интервал для доли (Вилсон). На малых выборках честнее обычного:
    винрейт «6 из 10» — это где-то от 31% до 83%, и это надо видеть.
    """
    if total == 0:
        return (np.nan, np.nan)
    p = successes / total
    denom = 1 + z**2 / total
    centre = (p + z**2 / (2 * total)) / denom
    margin = z * np.sqrt(p * (1 - p) / total + z**2 / (4 * total**2)) / denom
    return (max(0.0, centre - margin), min(1.0, centre + margin))


def bootstrap_mean_ci(values: np.ndarray, n_boot: int = 5000, seed: int = 17) -> tuple[float, float]:
    """Бутстрэп-интервал среднего (для суммарной экспектации в R)."""
    v = np.asarray(values, dtype=float)
    v = v[np.isfinite(v)]
    if v.size < 3:
        return (np.nan, np.nan)
    rng = np.random.default_rng(seed)
    means = rng.choice(v, size=(n_boot, v.size), replace=True).mean(axis=1)
    return (float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5)))


# --- Скан порогов ------------------------------------------------------------------------
#
# Реальные торговые эффекты часто пороговые: «RSI выше 70 — плохо», а не «чем выше RSI,
# тем хуже». Манна-Уитни сравнивает распределения целиком и на хвостовом эффекте
# почти бессилен. Поэтому отдельно ищем точки разреза.
#
# Плата за это — колоссальное раздувание ложных находок: перебирая 90 признаков на
# 7 порогах, мы делаем 630 проверок и ГАРАНТИРОВАННО найдём «правило» на случайных
# данных. Лечится единственно честным способом: то же самое проделывается на
# перемешанных метках, и настоящая находка обязана побить максимум, достижимый на шуме.


def _build_threshold_masks(df: pd.DataFrame, cols: list[str], n_cuts: int, min_side: int):
    """Маски «признак выше порога» для всех пар (признак, порог)."""
    masks, meta = [], []
    n = len(df)
    for col in cols:
        v = pd.to_numeric(df[col], errors="coerce").to_numpy(dtype=float)
        finite = np.isfinite(v)
        if finite.sum() < 2 * min_side:
            continue
        qs = np.quantile(v[finite], np.linspace(0.2, 0.8, n_cuts))
        for thr in np.unique(qs):
            hi = finite & (v > thr)
            lo = finite & (v <= thr)
            if hi.sum() < min_side or lo.sum() < min_side:
                continue
            masks.append(hi)
            meta.append((col, ">", float(thr), int(hi.sum()), int(lo.sum())))
            masks.append(lo)
            meta.append((col, "<=", float(thr), int(lo.sum()), int(hi.sum())))
    if not masks:
        return np.zeros((n, 0), dtype=bool), []
    return np.column_stack(masks), meta


def _scan_stats(masks: np.ndarray, y: np.ndarray) -> np.ndarray:
    """
    Для каждой маски: z-статистика разницы долей «внутри маски» против «снаружи».
    Векторизовано — один матричный продукт вместо тысяч отдельных тестов.
    """
    n_in = masks.sum(axis=0).astype(float)
    wins_in = y @ masks
    total, wins_total = float(y.size), float(y.sum())
    n_out = total - n_in
    wins_out = wins_total - wins_in

    with np.errstate(divide="ignore", invalid="ignore"):
        p_in = wins_in / n_in
        p_out = wins_out / n_out
        p_pool = wins_total / total
        se = np.sqrt(p_pool * (1 - p_pool) * (1 / n_in + 1 / n_out))
        z = np.where(se > 0, (p_in - p_out) / se, 0.0)
    return np.nan_to_num(z, nan=0.0, posinf=0.0, neginf=0.0)


def threshold_scan(
    df: pd.DataFrame, cols: list[str], labels: pd.Series,
    n_cuts: int = 7, min_side: int = 8, n_perm: int = 300, seed: int = 17,
) -> tuple[pd.DataFrame, dict]:
    """
    Поиск правил вида «признак выше/ниже порога -> другой винрейт».

    Возвращает таблицу правил и порог значимости, полученный перестановками:
    правило считается находкой, только если его |z| выше 95-го перцентиля
    МАКСИМАЛЬНОГО |z|, достижимого на случайных метках.
    """
    masks, meta = _build_threshold_masks(df, cols, n_cuts, min_side)
    if masks.shape[1] == 0:
        return pd.DataFrame(), {"threshold_z": np.nan, "n_rules": 0, "n_perm": n_perm}

    y = labels.to_numpy(dtype=float)
    z_real = _scan_stats(masks, y)

    rng = np.random.default_rng(seed)
    null_max = np.empty(n_perm)
    for i in range(n_perm):
        null_max[i] = np.abs(_scan_stats(masks, rng.permutation(y))).max()
    z_crit = float(np.percentile(null_max, 95))

    base = float(y.mean())
    out = pd.DataFrame(
        [{"feature": col, "op": op, "threshold": thr, "n_in": n_in, "n_out": n_out, "z": float(z)}
         for (col, op, thr, n_in, n_out), z in zip(meta, z_real, strict=True)]
    )
    out["winrate_in"] = (y @ masks) / masks.sum(axis=0)
    out["baseline"] = base
    out["significant"] = out["z"].abs() > z_crit
    out = out.sort_values("z", key=np.abs, ascending=False).reset_index(drop=True)

    info = {
        "threshold_z": z_crit,
        "n_rules": int(masks.shape[1]),
        "n_perm": n_perm,
        "null_max_mean": float(null_max.mean()),
    }
    return out, info


def paired_bootstrap_ci(
    variant: np.ndarray, baseline: np.ndarray, n_boot: int = 5000, seed: int = 17,
) -> tuple[float, float, float]:
    """
    Доверительный интервал ПАРНОЙ разницы «вариант минус база» по одним и тем же сделкам.

    Сравнивать точечную экспектацию варианта с интервалом базы — терять мощность:
    сделки-то одни и те же, и общий для обоих разброс рынка в парной разнице
    сокращается. Возвращает (среднюю разницу, нижнюю границу, верхнюю).
    """
    v = np.asarray(variant, dtype=float)
    b = np.asarray(baseline, dtype=float)
    ok = np.isfinite(v) & np.isfinite(b)
    d = v[ok] - b[ok]
    if d.size < 3:
        return (np.nan, np.nan, np.nan)
    rng = np.random.default_rng(seed)
    means = rng.choice(d, size=(n_boot, d.size), replace=True).mean(axis=1)
    return (float(d.mean()), float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5)))

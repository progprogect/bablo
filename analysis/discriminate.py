"""
Что отличает тейки от стопов — и чего на этих данных сказать НЕЛЬЗЯ.

Порядок отчёта намеренно такой:
  1. Сколько данных. Всё остальное читается через эту цифру.
  2. Одномерный разбор: каждый признак отдельно, с размером эффекта и FDR-поправкой.
  3. Проверка перестановками: сколько «находок» даёт та же процедура на случайных
     метках. Реальные находки обязаны быть заметно выше этого фона.
  4. Многомерная модель на временнОм разбиении (учим на ранних сделках, проверяем
     на поздних) против модели на перемешанных метках.

Если п.4 показывает AUC около 0.5 — это тоже результат, и он честнее любого
списка «важных признаков»: индикаторы на входе не отличают тейк от стопа.

Запуск: python3 analysis/discriminate.py <папка-с-CSV>
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.load import build_dataset  # noqa: E402
from lib.stats import (  # noqa: E402
    effect_label, permutation_null, threshold_scan, univariate_screen, wilson_interval,
)

MIN_PER_GROUP = 5
ALPHA = 0.05


def hr(title: str = "") -> None:
    print("\n" + "=" * 78)
    if title:
        print(title)
        print("=" * 78)


def feature_columns(feats: pd.DataFrame) -> list[str]:
    """Числовые признаки: индикаторы, структура, экскурсии, ответы чек-листа, геометрия."""
    prefixes = ("5m.", "15m.", "1h.", "exc.", "struct.", "ans.")
    extra = ["planned_rr", "leverage", "risk_usd", "hour", "dow", "risk_distance", "duration_min"]
    cols = [c for c in feats.columns if c.startswith(prefixes) and not c.endswith("__txt")]
    cols += [c for c in extra if c in feats.columns]
    # Только реально числовые и не константы
    out = []
    for c in cols:
        s = pd.to_numeric(feats[c], errors="coerce")
        if s.notna().sum() >= 2 * MIN_PER_GROUP and s.nunique(dropna=True) > 1:
            out.append(c)
    return out


def leakage_guard(cols: list[str]) -> tuple[list[str], list[str]]:
    """
    Признаки, известные только ПОСЛЕ сделки, нельзя спрашивать «предскажи исход».
    duration_min, MAE/MFE — следствие исхода, а не его причина.
    """
    leaky_markers = ("exc.maeR", "exc.mfeR", "duration_min")
    leaky = [c for c in cols if any(m in c for m in leaky_markers)]
    return [c for c in cols if c not in leaky], leaky


def run(raw_dir: str) -> None:
    trades, feats, _, _ = build_dataset(raw_dir)

    hr("1. СКОЛЬКО ДАННЫХ")
    if trades.empty:
        print("Сделок нет — анализировать нечего.")
        return

    counts = trades["outcome"].value_counts()
    print(f"Закрытых сделок: {len(trades)}")
    print(f"Период: {trades['opened_at'].min():%Y-%m-%d} .. {trades['opened_at'].max():%Y-%m-%d}")
    print(f"Символов: {trades['symbol'].nunique()}")
    print("\nИсходы (по экономике, как в статистике приложения):")
    for name, label in (("tp", "тейк"), ("sl", "стоп"), ("be", "безубыток"), ("other", "прочее")):
        n = int(counts.get(name, 0))
        print(f"  {label:<11} {n:>4}")

    n_tp, n_sl = int(counts.get("tp", 0)), int(counts.get("sl", 0))
    if min(n_tp, n_sl) < MIN_PER_GROUP:
        print(f"\nВ одной из групп меньше {MIN_PER_GROUP} сделок — сравнивать нечего. Стоп.")
        return

    lo, hi = wilson_interval(n_tp, n_tp + n_sl)
    print(f"\nВинрейт (тейк / тейк+стоп): {n_tp / (n_tp + n_sl):.1%}")
    print(f"  95% доверительный интервал: {lo:.1%} .. {hi:.1%}")
    print(f"  <- при {n_tp + n_sl} сделках истинный винрейт лежит где-то здесь.")

    # Сколько признаков на одну сделку — ключевая цифра для доверия
    subset = feats[feats["outcome"].isin(["tp", "sl"])].copy()
    cols_all = feature_columns(subset)
    cols, leaky = leakage_guard(cols_all)
    print(f"\nПризнаков для анализа: {len(cols)}")
    if leaky:
        print(f"  Исключены как «знание из будущего»: {', '.join(leaky)}")
    ratio = len(cols) / max(n_tp + n_sl, 1)
    print(f"  Признаков на сделку: {ratio:.2f}", end="")
    print("  <- НОРМА" if ratio < 0.2 else "  <- МНОГО: риск найти узор в шуме высок")

    y = (subset["outcome"] == "tp").astype(int)

    hr("2. ОДНОМЕРНЫЙ РАЗБОР: каждый признак отдельно")
    screen = univariate_screen(subset, cols, y == 1, y == 0, min_per_group=MIN_PER_GROUP)
    if screen.empty:
        print("Ни один признак не набрал достаточного покрытия.")
        return

    raw_hits = int((screen["p"] < ALPHA).sum())
    fdr_hits = int((screen["q"] < ALPHA).sum())
    print(f"Проверено признаков: {len(screen)}")
    print(f"  p < {ALPHA} (без поправки):      {raw_hits}")
    print(f"  q < {ALPHA} (с поправкой FDR):   {fdr_hits}   <- вот это и есть находки")
    print(f"\nОжидание ложных срабатываний без поправки: ~{len(screen) * ALPHA:.1f} штук.")

    print("\nТоп-15 по p-значению (median_a = тейки, median_b = стопы):")
    show = screen.head(15).copy()
    show["признак"] = show["feature"]
    show["тейки"] = show["median_a"].map(lambda v: f"{v:,.4g}")
    show["стопы"] = show["median_b"].map(lambda v: f"{v:,.4g}")
    show["эффект"] = show.apply(lambda r: f"{r['delta']:+.2f} ({r['effect']})", axis=1)
    show["p"] = show["p"].map(lambda v: f"{v:.4f}")
    show["q"] = show["q"].map(lambda v: f"{v:.3f}")
    show["вывод"] = np.where(show["q"].astype(float) < ALPHA, "ЗНАЧИМО", "шум")
    print(show[["признак", "тейки", "стопы", "эффект", "p", "q", "вывод"]].to_string(index=False))

    hr("3. ПРОВЕРКА ПЕРЕСТАНОВКАМИ: сколько находок даёт чистый шум")
    print("Перемешиваем метки тейк/стоп и прогоняем ту же процедуру...")
    null = permutation_null(subset, cols, y, n_perm=150, alpha=ALPHA)
    print(f"  На случайных метках находок (p<{ALPHA}): среднее {null['mean']:.1f}, "
          f"95-й перцентиль {null['p95']:.0f}, максимум {null['max']}")
    print(f"  На реальных метках: {raw_hits}")
    if raw_hits > null["p95"]:
        print("  -> Реальных находок БОЛЬШЕ, чем даёт шум. В данных есть структура.")
    else:
        print("  -> По этому счётчику — не больше, чем даёт шум.")
    if fdr_hits > 0 and raw_hits <= null["p95"]:
        print("\n  ВАЖНО: этот счётчик и FDR из раздела 2 могут расходиться, и здесь так и вышло.")
        print("  Причина — признаки сильно скоррелированы между собой (один и тот же смысл")
        print("  на 5м/15м/1ч, RSI и стохастик, MACD и расстояние до EMA). Когда перемешивание")
        print("  случайно совпадает с таким блоком, срабатывает сразу пачка признаков, и")
        print("  разброс счётчика на шуме получается огромным. Поэтому счётчик здесь")
        print("  ЗАНИЖАЕТ чувствительность, а опорными остаются FDR (раздел 2) и скан")
        print("  порогов (раздел 4) — там контроль идёт по максимуму статистики, а не по счёту.")

    hr("4. СКАН ПОРОГОВ: правила вида «признак выше/ниже X»")
    print("Манна-Уитни сравнивает распределения целиком и почти не видит эффектов,")
    print("сидящих в хвосте («RSI выше 70 — плохо»). Ищем точки разреза отдельно.\n")
    scan, info = threshold_scan(subset, cols, y, n_perm=300)
    if scan.empty:
        print("Правил с достаточным размером групп не набралось.")
    else:
        print(f"Проверено правил: {info['n_rules']}")
        print(f"Порог значимости |z| по перестановкам: {info['threshold_z']:.2f} "
              f"(наивный порог был бы 1.96)")
        print(f"  <- перебор {info['n_rules']} правил сам по себе рождает находки; "
              f"это и есть плата за него.\n")
        # Показываем только правила «выше порога» — «ниже» это их зеркало с тем же |z|
        top = scan[scan["op"] == ">"].head(10).copy()
        out_tbl = pd.DataFrame({
            "правило": top["feature"] + " > " + top["threshold"].map(lambda v: f"{v:.4g}"),
            "n": top["n_in"],
            "винрейт": top["winrate_in"].map(lambda v: f"{v:.0%}"),
            "база": top["baseline"].map(lambda v: f"{v:.0%}"),
            "z": top["z"].map(lambda v: f"{v:+.2f}"),
            "вывод": np.where(top["significant"], "ЗНАЧИМО", "шум"),
        })
        print(out_tbl.to_string(index=False))
        n_sig = int(scan["significant"].sum())
        print(f"\nПравил, побивших перестановочный порог: {n_sig}")
        if n_sig == 0:
            print("  -> Ни одно пороговое правило не отличимо от того, что даёт перебор на шуме.")

    hr("5. МНОГОМЕРНАЯ МОДЕЛЬ на временнОм разбиении")
    try:
        model_check(subset, cols, y)
    except ImportError:
        print("scikit-learn не установлен — раздел пропущен.")

    hr("ИТОГ")
    sig = screen[screen["q"] < ALPHA]
    if sig.empty:
        print("Признаков, переживших поправку на множественные сравнения, НЕТ.")
        print("Это значит: по индикаторам на входе тейк от стопа не отличается —")
        print("по крайней мере, на текущем объёме данных. Не 'зависимостей нет вообще',")
        print("а 'данных не хватает, чтобы их увидеть'.")
    else:
        print("Признаки, пережившие поправку FDR:")
        for r in sig.itertuples():
            direction = "выше у ТЕЙКОВ" if r.delta > 0 else "выше у СТОПОВ"
            print(f"  {r.feature:<34} {direction:<16} эффект {r.delta:+.2f} ({effect_label(r.delta)}), q={r.q:.3f}")


def model_check(subset: pd.DataFrame, cols: list[str], y: pd.Series) -> None:
    """Модель на временнОм разбиении против той же модели на перемешанных метках."""
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import TimeSeriesSplit
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.impute import SimpleImputer

    X = subset[cols].apply(pd.to_numeric, errors="coerce")
    n = len(X)
    if n < 40:
        print(f"Сделок {n} — для честной проверки модели мало (нужно хотя бы 40).")
        print("Раздел пропущен намеренно: на таком объёме любой AUC — случайность.")
        return

    n_splits = min(5, max(2, n // 20))
    splitter = TimeSeriesSplit(n_splits=n_splits)
    models = {
        "логистическая регрессия": make_pipeline(
            SimpleImputer(strategy="median"), StandardScaler(),
            LogisticRegression(max_iter=2000, C=0.1, class_weight="balanced"),
        ),
        "градиентный бустинг": make_pipeline(
            SimpleImputer(strategy="median"),
            HistGradientBoostingClassifier(max_depth=3, max_iter=120, learning_rate=0.06,
                                           min_samples_leaf=8, random_state=17),
        ),
    }

    print(f"Разбиение: {n_splits} последовательных фолдов (учим на прошлом, проверяем на будущем).")
    print(f"Сделок: {n}. Это единственно честный способ — случайное разбиение подсматривает вперёд.\n")

    rng = np.random.default_rng(17)
    for name, model in models.items():
        real = _cv_auc(model, X, y, splitter, roc_auc_score)
        perm = [
            _cv_auc(model, X, pd.Series(rng.permutation(y.to_numpy()), index=y.index),
                    splitter, roc_auc_score)
            for _ in range(12)
        ]
        perm = [p for p in perm if np.isfinite(p)]
        perm_mean = float(np.mean(perm)) if perm else np.nan
        perm_p95 = float(np.percentile(perm, 95)) if perm else np.nan

        print(f"{name}:")
        print(f"  AUC на реальных метках:      {real:.3f}")
        print(f"  AUC на перемешанных метках:  {perm_mean:.3f} (95-й перцентиль {perm_p95:.3f})")
        if not np.isfinite(real):
            print("  -> Фолды вырождены (в тесте один класс). Вывод сделать нельзя.\n")
        elif real > perm_p95 and real > 0.6:
            print("  -> Модель РЕАЛЬНО что-то улавливает: выше и шума, и порога 0.6.\n")
        elif real > perm_p95:
            print("  -> Выше шума, но AUC ниже 0.6 — практической ценности мало.\n")
        else:
            print("  -> Не отличается от случайной. Признаки на входе исход не предсказывают.\n")


def _cv_auc(model, X, y, splitter, scorer) -> float:
    scores = []
    for train_idx, test_idx in splitter.split(X):
        y_tr, y_te = y.iloc[train_idx], y.iloc[test_idx]
        if y_tr.nunique() < 2 or y_te.nunique() < 2:
            continue
        try:
            model.fit(X.iloc[train_idx], y_tr)
            proba = model.predict_proba(X.iloc[test_idx])[:, 1]
            scores.append(scorer(y_te, proba))
        except Exception:
            continue
    return float(np.mean(scores)) if scores else np.nan


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "data/raw")

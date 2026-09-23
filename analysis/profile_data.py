"""
Проверка полноты выгрузки — запускать ПЕРВЫМ.

Смысл: до любых выводов понять, чем мы вообще располагаем. Контрфактический анализ
живёт на свечах, поиск зависимостей — на снапшотах индикаторов. Если их нет у
половины сделок, это надо знать заранее, а не удивляться пустым таблицам.

Запуск: python3 analysis/profile_data.py <папка-с-CSV>
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.load import INTERVALS, build_dataset, to_epoch_ms  # noqa: E402
from lib.replay import find_bar_index  # noqa: E402

STEP_MS = {"5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000}


def hr(title: str) -> None:
    print("\n" + "=" * 78)
    print(title)
    print("=" * 78)


def run(raw_dir: str) -> None:
    trades, feats, candles, raw = build_dataset(raw_dir)

    hr("ТАБЛИЦЫ В ВЫГРУЗКЕ")
    for name, df in raw.items():
        state = f"{len(df):>7} строк" if not df.empty else "      пусто"
        print(f"  {name:<28} {state}")

    if trades.empty:
        print("\nЗакрытых сделок нет — дальше смотреть нечего.")
        return

    hr("СДЕЛКИ")
    print(f"Закрытых: {len(trades)}")
    print(f"Период: {trades['opened_at'].min():%Y-%m-%d} .. {trades['opened_at'].max():%Y-%m-%d}")
    print(f"\nПричина закрытия (как записала биржа):")
    for reason, n in trades["close_reason"].value_counts().items():
        print(f"  {str(reason):<12} {n:>5}")
    print(f"\nИсход для статистики (по экономике):")
    for outcome, n in trades["outcome"].value_counts().items():
        print(f"  {outcome:<12} {n:>5}")

    print(f"\nПо символам:")
    by_sym = trades.groupby("symbol").agg(
        сделок=("id", "size"),
        тейков=("outcome", lambda s: (s == "tp").sum()),
        стопов=("outcome", lambda s: (s == "sl").sum()),
        сумма_R=("result_r", "sum"),
    ).sort_values("сделок", ascending=False)
    print(by_sym.round(2).to_string())

    hr("КАЧЕСТВО ГЕОМЕТРИИ ВХОДА")
    checks = [
        ("есть цена входа", trades["entry_price"].notna()),
        ("есть risk_usd", trades["risk_usd"].notna() & (trades["risk_usd"] > 0)),
        ("восстановлен стоп при входе", trades["initial_sl"].notna()),
        ("есть тейк при входе (tp_price_initial)", trades["tp_price_initial"].notna()),
        ("есть planned_rr", trades["planned_rr"].notna()),
        ("есть result_r", trades["result_r"].notna()),
        ("была частичная фиксация", trades["had_partial"] if "had_partial" in trades else pd.Series(False, index=trades.index)),
        ("сработало ночное правило TP", trades["night_tp"] if "night_tp" in trades else pd.Series(False, index=trades.index)),
    ]
    for label, mask in checks:
        n = int(mask.sum())
        print(f"  {label:<42} {n:>5} из {len(trades)}  ({n / len(trades):.0%})")

    if trades["planned_rr"].notna().any():
        print(f"\nПлановый R/R: медиана {trades['planned_rr'].median():.2f}, "
              f"квартили {trades['planned_rr'].quantile(0.25):.2f} .. "
              f"{trades['planned_rr'].quantile(0.75):.2f}")

    hr("СНАПШОТЫ ИНДИКАТОРОВ")
    m = raw["journal_trade_metrics"]
    if m.empty:
        print("journal_trade_metrics пуста — поиск зависимостей по индикаторам невозможен.")
    else:
        print(f"Снапшотов: {len(m)} на {len(trades)} закрытых сделок "
              f"({len(m) / len(trades):.0%})")
        if "version" in m.columns:
            print(f"Версии формул: {sorted(m['version'].dropna().unique().tolist())}")
            if m["version"].nunique() > 1:
                print("  ВНИМАНИЕ: версии разные — часть снапшотов считалась старыми формулами.")
                print("  Сравнивать их напрямую нельзя без пересчёта.")
        print("\nПокрытие по таймфреймам (доля сделок с непустым снапшотом):")
        for interval in INTERVALS:
            cols = [c for c in feats.columns if c.startswith(f"{interval}.")]
            if cols:
                cov = feats[cols].notna().any(axis=1).mean()
                print(f"  {interval:<5} {cov:.0%}  ({len(cols)} признаков)")
            else:
                print(f"  {interval:<5} нет данных")

    hr("СВЕЧИ (основа контрфактического анализа)")
    if not candles:
        print("Свечей нет — раздел «а если бы» работать не будет.")
    else:
        print("Серий (символ x таймфрейм):", len(candles))
        for interval in INTERVALS:
            keys = [k for k in candles if k[1] == interval]
            total = sum(len(candles[k]) for k in keys)
            print(f"  {interval:<5} {len(keys):>3} символов, {total:>8} свечей")

        # Главное: накрывают ли свечи момент входа каждой сделки
        print("\nПокрытие момента входа (без него сделку не проиграть заново):")
        opened_ms_all = to_epoch_ms(trades["opened_at"])
        for interval in INTERVALS:
            covered = 0
            for r, opened_ms in zip(trades.itertuples(), opened_ms_all, strict=True):
                df = candles.get((r.symbol, interval))
                if df is None:
                    continue
                if find_bar_index(df["t_ms"].to_numpy(), int(opened_ms), STEP_MS[interval]) is not None:
                    covered += 1
            print(f"  {interval:<5} {covered:>5} из {len(trades)}  ({covered / len(trades):.0%})")

        # Глубина вперёд от закрытия — сколько «будущего» доступно
        print("\nЗапас свечей ПОСЛЕ закрытия сделки (нужен, чтобы проверить широкий стоп):")
        for interval in INTERVALS:
            ahead = []
            closed_ms_all = to_epoch_ms(trades["closed_at"])
            for r, closed_ms in zip(trades.itertuples(), closed_ms_all, strict=True):
                df = candles.get((r.symbol, interval))
                if df is None or pd.isna(r.closed_at):
                    continue
                ahead.append(int((df["t_ms"].to_numpy() > int(closed_ms)).sum()))
            if ahead:
                a = np.array(ahead)
                print(f"  {interval:<5} медиана {np.median(a):>6.0f} свечей, "
                      f"минимум {a.min():>5}, доля без запаса {(a == 0).mean():.0%}")

    hr("РАЗБОР В ЖУРНАЛЕ")
    entries = raw["journal_entries"]
    if entries.empty:
        print("Разборов нет — субъективные признаки в анализе не участвуют.")
    else:
        print(f"Разобрано сделок: {len(entries)} из {len(trades)} ({len(entries) / len(trades):.0%})")
        cats = raw["journal_categories"]
        if not cats.empty:
            names = dict(zip(cats["id"], cats["name"]))
            print("\nПо категориям:")
            for cid, n in entries["category_id"].value_counts().items():
                print(f"  {str(names.get(cid, cid)):<28} {n:>5}")
        ans_cols = [c for c in feats.columns if c.startswith("ans.")]
        if ans_cols:
            print(f"\nПризнаков из чек-листов: {len(ans_cols)}")
            for c in ans_cols[:12]:
                print(f"  {c:<52} заполнено {feats[c].notna().sum():>4}")

    hr("ВЫВОД")
    n_tp = int((trades["outcome"] == "tp").sum())
    n_sl = int((trades["outcome"] == "sl").sum())
    print(f"Тейков {n_tp}, стопов {n_sl}.")
    if min(n_tp, n_sl) < 10:
        print("Этого мало для статистических выводов — читать отчёты как гипотезы, не как факты.")
    elif min(n_tp, n_sl) < 30:
        print("Объём небольшой: находить можно только КРУПНЫЕ эффекты. Слабые неотличимы от шума.")
    else:
        print("Объёма хватает для поиска умеренных эффектов.")
    print("\nДальше: python3 analysis/discriminate.py <папка>   — что отличает тейки от стопов")
    print("        python3 analysis/counterfactual.py <папка> — что спасло бы стопы")


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "data/raw")

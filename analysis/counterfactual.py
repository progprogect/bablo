"""
«А если бы стоп был шире / тейк ближе / вход позже» — проверка по свечам.

Это не машинное обучение, а детерминированный прогон: берём реальные свечи вокруг
каждой сделки и смотрим, чем бы она кончилась при другой геометрии.

Три правила, без которых такой анализ превращается в самообман:

  1. ПРАВИЛО ПРИМЕНЯЕТСЯ КО ВСЕМ СДЕЛКАМ, а не только к убыточным. Расширив стоп,
     легко «спасти» половину стопов — и незаметно превратить часть тейков в стопы
     большего размера. Смотреть только на проигравшие = гарантированно получить
     стратегию, которая теряет деньги.

  2. БАЗА СРАВНЕНИЯ — ТОТ ЖЕ ДВИЖОК. Вариант сравнивается не с фактической историей,
     а с прогоном исходной геометрии через тот же реплей: иначе в «улучшение»
     попадёт собственная погрешность движка.

  3. НЕОПРЕДЕЛЁННЫЙ ИСХОД — НЕ ПОБЕДА. Если свечей не хватило, сделка помечается
     undetermined и в экспектацию не идёт; её доля показывается отдельно.

Плюс поправка на перебор: сетка из десятков вариантов сама по себе найдёт «лучший»
на случайных данных, поэтому рядом с лучшим вариантом печатается доверительный
интервал и доля сетки, улучшившая базу.

Запуск: python3 analysis/counterfactual.py <папка-с-CSV>
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.load import build_dataset, to_epoch_ms  # noqa: E402
from lib.replay import TradeReplayer  # noqa: E402
from lib.stats import bootstrap_mean_ci, paired_bootstrap_ci  # noqa: E402


def hr(title: str = "") -> None:
    print("\n" + "=" * 78)
    if title:
        print(title)
        print("=" * 78)


def tradeset(trades: pd.DataFrame) -> pd.DataFrame:
    """Сделки, пригодные для реплея: есть цена входа, риск и время."""
    t = trades[trades["outcome"].isin(["tp", "sl", "be"])].copy()
    t = t[t["entry_price"].notna() & t["risk_distance"].notna() & (t["risk_distance"] > 0)]
    t["opened_ms"] = to_epoch_ms(t["opened_at"])
    return t


def simulate(
    t: pd.DataFrame, rp: TradeReplayer, sl_mult: float, tp_mult: float | None,
    *, use_planned_tp: bool = False, entry_offset: int = 0,
    be_trigger: float | None = None, optimistic: bool = False,
) -> pd.DataFrame:
    """Прогон одного правила по всем сделкам."""
    rows = []
    for r in t.itertuples():
        target = r.planned_rr if use_planned_tp else tp_mult
        if target is not None and (not np.isfinite(target) or target <= 0):
            target = None
        res, tf = rp.run(
            r.symbol, r.side, int(r.opened_ms), float(r.entry_price), float(r.risk_distance),
            sl_mult, target, entry_offset_bars=entry_offset,
            be_trigger_r=be_trigger, optimistic=optimistic,
        )
        rows.append({
            "id": r.id, "outcome_real": r.outcome, "result_r_real": r.result_r,
            "outcome_sim": res.outcome, "result_r_sim": res.result_r,
            "bars": res.bars_held, "tf": tf, "ambiguous": res.ambiguous_bar,
        })
    return pd.DataFrame(rows)


def summarize(sim: pd.DataFrame) -> dict:
    """Сводка по прогону. Неопределённые исходы в экспектацию НЕ входят."""
    resolved = sim[sim["outcome_sim"] != "undetermined"]
    n_res = len(resolved)
    r = resolved["result_r_sim"].to_numpy(dtype=float)
    wins = int((resolved["outcome_sim"] == "tp").sum())
    return {
        "n_total": len(sim),
        "n_resolved": n_res,
        "undetermined_pct": (len(sim) - n_res) / max(len(sim), 1) * 100,
        "winrate": wins / n_res * 100 if n_res else np.nan,
        "expectancy_r": float(np.nanmean(r)) if n_res else np.nan,
        "total_r": float(np.nansum(r)) if n_res else np.nan,
        "ambiguous_pct": resolved["ambiguous"].mean() * 100 if n_res else np.nan,
    }


def run(raw_dir: str) -> None:
    trades, feats, candles, _ = build_dataset(raw_dir)
    if trades.empty:
        print("Сделок нет.")
        return
    if not candles:
        print("Свечей нет — контрфактический анализ невозможен.")
        print("Проверь, что journal_candles.csv не пуст.")
        return

    t = tradeset(trades)
    rp = TradeReplayer(candles)

    hr("0. КАЛИБРОВКА: воспроизводит ли движок реальные исходы")
    print("Прогоняем ФАКТИЧЕСКУЮ геометрию (стоп 1R, тейк по плану) и сравниваем")
    print("с тем, что было на самом деле. Все выводы ниже стоят ровно столько,")
    print("сколько стоит эта цифра.\n")

    base = simulate(t, rp, 1.0, None, use_planned_tp=True)
    ok = base["outcome_sim"] != "undetermined"
    matched = ((base["outcome_sim"] == base["outcome_real"]) & ok).sum()
    n_cmp = int(ok.sum())
    print(f"Сделок в реплее: {len(base)}")
    print(f"  исход определился: {n_cmp} ({n_cmp / len(base):.0%})")
    if n_cmp:
        print(f"  совпал с фактическим: {matched} из {n_cmp} ({matched / n_cmp:.0%})")
        acc = matched / n_cmp
        if acc < 0.7:
            print("\n  ВНИМАНИЕ: воспроизводимость ниже 70%. Возможные причины —")
            print("  частичные фиксации, ручные закрытия, подвинутый трейлингом стоп,")
            print("  проскальзывание. Выводы ниже принимать с большой осторожностью.")
        elif acc < 0.85:
            print("\n  Воспроизводимость средняя: к цифрам относиться как к ориентиру,")
            print("  а не к точному расчёту.")
        else:
            print("\n  Воспроизводимость хорошая — движку можно доверять.")

    mism = base[ok & (base["outcome_sim"] != base["outcome_real"])]
    if not mism.empty:
        print(f"\n  Расхождения по типам (факт -> реплей):")
        pairs = mism.groupby(["outcome_real", "outcome_sim"]).size().sort_values(ascending=False)
        for (real, simv), n in pairs.head(6).items():
            print(f"    {real} -> {simv}: {n}")

    base_stats = summarize(base)
    print(f"\nБАЗА (как торговали): винрейт {base_stats['winrate']:.0f}%, "
          f"экспектация {base_stats['expectancy_r']:+.3f}R на сделку, "
          f"сумма {base_stats['total_r']:+.1f}R")
    print(f"  неопределённых: {base_stats['undetermined_pct']:.0f}%, "
          f"неоднозначных свечей: {base_stats['ambiguous_pct']:.0f}%")

    # --- Сетка стоп x тейк ---
    hr("1. СЕТКА: шире стоп x ближе тейк")
    print("Ограничения из задачи соблюдены: тейк не ближе 1R, стоп не шире 2R.")
    print("Экспектация — в R от ИСХОДНОГО риска, поэтому варианты сравнимы между собой.")
    print("Пессимистичный сценарий: в спорной свече первым сработал стоп.\n")

    sl_grid = [1.0, 1.25, 1.5, 1.75, 2.0]
    tp_grid = [1.0, 1.5, 2.0, 2.5, 3.0]
    rows = []
    for sl in sl_grid:
        for tp in tp_grid:
            s = summarize(simulate(t, rp, sl, tp))
            s.update({"sl_mult": sl, "tp_mult": tp})
            rows.append(s)
    grid = pd.DataFrame(rows)

    pivot = grid.pivot(index="sl_mult", columns="tp_mult", values="expectancy_r")
    print("Экспектация (R на сделку). Строки — стоп в R, колонки — тейк в R:")
    print(pivot.round(3).to_string())

    pv_w = grid.pivot(index="sl_mult", columns="tp_mult", values="winrate")
    print("\nВинрейт, %:")
    print(pv_w.round(0).to_string())

    pv_u = grid.pivot(index="sl_mult", columns="tp_mult", values="undetermined_pct")
    print("\nДоля неопределённых исходов, % (высокая = свечей не хватило, верить нельзя):")
    print(pv_u.round(0).to_string())

    hr("2. ЛУЧШИЙ ВАРИАНТ СЕТКИ — и насколько ему можно верить")
    usable = grid[grid["undetermined_pct"] < 25].copy()
    if usable.empty:
        print("Все варианты сетки упираются в нехватку свечей. Вывод сделать нельзя.")
    else:
        best = usable.loc[usable["expectancy_r"].idxmax()]
        print(f"Лучший: стоп {best['sl_mult']}R, тейк {best['tp_mult']}R")
        print(f"  экспектация {best['expectancy_r']:+.3f}R против базовой "
              f"{base_stats['expectancy_r']:+.3f}R")
        print(f"  винрейт {best['winrate']:.0f}%, неопределённых {best['undetermined_pct']:.0f}%")

        best_sim = simulate(t, rp, best["sl_mult"], best["tp_mult"])
        r_best = best_sim.loc[best_sim["outcome_sim"] != "undetermined", "result_r_sim"].to_numpy()
        lo, hi = bootstrap_mean_ci(r_best)
        print(f"  95% интервал экспектации: {lo:+.3f}R .. {hi:+.3f}R")

        # Парное сравнение по одним и тем же сделкам — мощнее, чем сравнение интервалов
        pair = best_sim.set_index("id")[["result_r_sim"]].join(
            base.set_index("id")[["result_r_sim"]], rsuffix="_base", how="inner")
        diff, dlo, dhi = paired_bootstrap_ci(
            pair["result_r_sim"].to_numpy(), pair["result_r_sim_base"].to_numpy())
        print(f"\n  Парная разница с базой (одни и те же сделки): {diff:+.3f}R на сделку")
        print(f"  95% интервал разницы: {dlo:+.3f}R .. {dhi:+.3f}R")
        if not np.isfinite(dlo):
            print("  -> Данных для парного сравнения не хватило.")
        elif dlo > 0:
            print("  -> Интервал разницы целиком выше нуля: улучшение устойчиво.")
        elif dhi < 0:
            print("  -> Интервал целиком ниже нуля: вариант ХУЖЕ базы.")
        else:
            print("  -> Интервал накрывает ноль: преимущество НЕ доказано,")
            print("     разница в пределах случайного разброса.")
        print("\n  Помни: это ЛУЧШАЯ клетка из перебранных — сам перебор добавляет")
        print("  оптимизма, которого интервал не учитывает. Опора — строчка ниже.")

        better = (usable["expectancy_r"] > base_stats["expectancy_r"]).mean()
        print(f"\nДоля вариантов сетки, улучшивших базу: {better:.0%}")
        if better > 0.6:
            print("  -> Улучшает почти вся сетка. Это признак устойчивого направления,")
            print("     а не удачно подобранной клетки.")
        elif better < 0.25:
            print("  -> Улучшает лишь малая часть сетки. Похоже на подгонку под шум.")

        # Оптимистичный сценарий — верхняя граница
        opt = summarize(simulate(t, rp, best["sl_mult"], best["tp_mult"], optimistic=True))
        print(f"\nОптимистичный сценарий (в спорной свече первым тейк): "
              f"{opt['expectancy_r']:+.3f}R")
        print(f"  Истина между {best['expectancy_r']:+.3f}R и {opt['expectancy_r']:+.3f}R.")

    # --- Что стало бы со стопами ---
    hr("3. СДЕЛКИ, ЗАКРЫТЫЕ ПО СТОПУ: что бы их спасло")
    sl_trades = t[t["outcome"] == "sl"]
    print(f"Стопов в выборке: {len(sl_trades)}\n")
    if len(sl_trades) >= 3:
        print("Сколько стопов стало бы тейками — и ЧЕМ ЗА ЭТО ПЛАТИМ на остальных сделках:\n")
        print(f"{'правило':<26}{'спасено':>9}{'испорчено':>11}{'экспект.':>11}{'против базы':>13}")
        print("-" * 70)
        for sl in sl_grid:
            for tp in (1.0, 1.5, 2.0):
                sim = simulate(t, rp, sl, tp)
                merged = sim.set_index("id")
                saved = int(((merged["outcome_real"] == "sl") & (merged["outcome_sim"] == "tp")).sum())
                spoiled = int(((merged["outcome_real"] == "tp") & (merged["outcome_sim"] == "sl")).sum())
                s = summarize(sim)
                delta = s["expectancy_r"] - base_stats["expectancy_r"]
                label = f"стоп {sl}R, тейк {tp}R"
                print(f"{label:<26}{saved:>9}{spoiled:>11}{s['expectancy_r']:>+11.3f}{delta:>+13.3f}")
        print("\n«Спасено» само по себе ничего не значит — смотреть надо последнюю колонку.")
        print("«Испорчено» считает только тейки, ставшие стопами, и часто равно нулю.")
        print("Главная плата за близкий тейк другая: сделки, бравшие +3R, теперь берут +1R.")
        print("В колонке «спасено» этого не видно, в экспектации — видно.")

    # --- Стоп в ATR ---
    hr("4. ПЕРЕВОД В ATR (ограничение «стоп не шире 2 ATR»)")
    atr_col = "risk_in_atr_15m"
    if atr_col in feats.columns:
        ra = pd.to_numeric(feats.set_index("id").loc[t["id"], atr_col], errors="coerce")
        med = ra.median()
        if np.isfinite(med):
            print(f"Фактический стоп (1R) в единицах ATR(14, 15м): медиана {med:.2f} ATR")
            print(f"  квартили: {ra.quantile(0.25):.2f} .. {ra.quantile(0.75):.2f}\n")
            print("Во сколько ATR обходится каждый множитель стопа (по медиане):")
            for sl in sl_grid:
                mark = "" if sl * med <= 2.0 else "   <- ВЫХОДИТ ЗА 2 ATR"
                print(f"  стоп {sl}R = {sl * med:.2f} ATR{mark}")
        else:
            print("Не удалось сопоставить риск с ATR (нет снапшотов индикаторов).")
    else:
        print("Нет колонки risk_in_atr_15m — снапшоты индикаторов не собраны.")

    # --- Сдвиг входа ---
    hr("5. ВХОД РАНЬШЕ / ПОЗЖЕ")
    print("Сдвигаем вход на N свечей (5м), геометрия та же. Минус — раньше, плюс — позже.")
    print("Цена входа берётся по открытию сдвинутой свечи.\n")
    print(f"{'сдвиг':<12}{'винрейт':>10}{'экспект.':>11}{'против базы':>13}{'неопр.':>9}")
    print("-" * 56)
    for off in (-3, -2, -1, 0, 1, 2, 3):
        s = summarize(simulate(t, rp, 1.0, None, use_planned_tp=True, entry_offset=off))
        delta = s["expectancy_r"] - base_stats["expectancy_r"]
        label = "как было" if off == 0 else f"{off:+d} свечи"
        print(f"{label:<12}{s['winrate']:>9.0f}%{s['expectancy_r']:>+11.3f}"
              f"{delta:>+13.3f}{s['undetermined_pct']:>8.0f}%")

    # --- Безубыток ---
    hr("6. ПЕРЕВОД В БЕЗУБЫТОК")
    print("Двигаем стоп на цену входа после достижения X R. Геометрия — как в плане.\n")
    print(f"{'правило':<22}{'винрейт':>10}{'экспект.':>11}{'против базы':>13}")
    print("-" * 56)
    for be in (None, 0.5, 1.0, 1.5, 2.0):
        s = summarize(simulate(t, rp, 1.0, None, use_planned_tp=True, be_trigger=be))
        delta = s["expectancy_r"] - base_stats["expectancy_r"]
        label = "без безубытка" if be is None else f"БУ после +{be}R"
        print(f"{label:<22}{s['winrate']:>9.0f}%{s['expectancy_r']:>+11.3f}{delta:>+13.3f}")

    hr("КАК ЧИТАТЬ ЭТОТ ОТЧЁТ")
    print("1. Сначала смотри калибровку (раздел 0). Низкая воспроизводимость -> всё остальное")
    print("   лишь ориентир.")
    print("2. Решает ЭКСПЕКТАЦИЯ, а не число спасённых стопов и не винрейт: правило,")
    print("   поднимающее винрейт и роняющее экспектацию, теряет деньги.")
    print("3. Опорная цифра — ПАРНАЯ разница с базой и её интервал (раздел 2). Если интервал")
    print("   накрывает ноль, преимущество НЕ доказано, каким бы заманчивым ни было среднее.")
    print("4. Доля неопределённых выше 25% означает, что свечей не хватило; такие клетки")
    print("   сетки из выводов исключены.")


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "data/raw")

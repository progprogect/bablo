"""Тесты движка реплея. Запуск: python3 analysis/lib/test_replay.py"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.load import to_epoch_ms  # noqa: E402
from lib.replay import UNDETERMINED, find_bar_index, replay  # noqa: E402

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILURES.append(name)


def bars(rows):
    """rows: [(high, low, close), ...] -> массивы."""
    a = np.array(rows, dtype=float)
    return a[:, 0], a[:, 1], a[:, 2]


print("replay: базовые исходы")

# Лонг, вход 100, R=10. Тейк 120 (2R), стоп 90 (1R).
h, l, c = bars([(105, 98, 103), (112, 102, 110), (121, 109, 120)])
r = replay(h, l, c, 0, "long", 100, 90, 120, 10)
check("лонг доходит до тейка", r.outcome == "tp" and abs(r.result_r - 2.0) < 1e-9, f"-> {r}")

h, l, c = bars([(105, 98, 103), (104, 89, 91)])
r = replay(h, l, c, 0, "long", 100, 90, 120, 10)
check("лонг ловит стоп", r.outcome == "sl" and abs(r.result_r + 1.0) < 1e-9, f"-> {r}")

# Шорт, вход 100, R=10. Тейк 80, стоп 110.
h, l, c = bars([(102, 95, 96), (97, 79, 80)])
r = replay(h, l, c, 0, "short", 100, 110, 80, 10)
check("шорт доходит до тейка", r.outcome == "tp" and abs(r.result_r - 2.0) < 1e-9, f"-> {r}")

h, l, c = bars([(102, 95, 96), (111, 99, 110)])
r = replay(h, l, c, 0, "short", 100, 110, 80, 10)
check("шорт ловит стоп", r.outcome == "sl" and abs(r.result_r + 1.0) < 1e-9, f"-> {r}")

print("replay: честность на границах")

# Свечей не хватило — НЕ победа
h, l, c = bars([(105, 98, 103), (108, 101, 107)])
r = replay(h, l, c, 0, "long", 100, 90, 120, 10)
check("нет данных -> undetermined, а не tp", r.outcome == UNDETERMINED and np.isnan(r.result_r), f"-> {r}")

# Неоднозначная свеча: задеты и стоп, и тейк
h, l, c = bars([(121, 89, 100)])
pess = replay(h, l, c, 0, "long", 100, 90, 120, 10, optimistic=False)
opt = replay(h, l, c, 0, "long", 100, 90, 120, 10, optimistic=True)
check("неоднозначная свеча: пессимист -> стоп", pess.outcome == "sl" and pess.ambiguous_bar, f"-> {pess}")
check("неоднозначная свеча: оптимист -> тейк", opt.outcome == "tp" and opt.ambiguous_bar, f"-> {opt}")

print("replay: безубыток")

# Дотянулись до +1R на свече 0, затем откат к входу на свече 1 -> БУ, не стоп
# Тейк 115 достижим на третьей свече — иначе тест проверял бы не БУ, а нехватку данных.
h, l, c = bars([(110, 99, 108), (109, 99, 100), (115, 99, 114)])
r = replay(h, l, c, 0, "long", 100, 90, 115, 10, be_trigger_r=1.0)
check("БУ срабатывает после триггера", r.outcome == "be" and abs(r.result_r) < 1e-9, f"-> {r}")

# Без триггера БУ та же картина идёт дальше до тейка
r = replay(h, l, c, 0, "long", 100, 90, 115, 10, be_trigger_r=None)
check("без БУ сделка доживает до тейка", r.outcome == "tp", f"-> {r}")

# БУ не вооружается в той же свече, где был триггер (нет lookahead внутри бара)
h, l, c = bars([(112, 89, 95)])
r = replay(h, l, c, 0, "long", 100, 90, 130, 10, be_trigger_r=1.0)
check("БУ не спасает внутри своей же свечи", r.outcome == "sl", f"-> {r}")

print("replay: стоп по времени")

h, l, c = bars([(105, 98, 103), (106, 99, 104), (107, 100, 105)])
r = replay(h, l, c, 0, "long", 100, 90, 130, 10, max_bars=2)
check("timeout выходит по закрытию", r.outcome == "timeout" and abs(r.result_r - 0.4) < 1e-9, f"-> {r}")

print("replay: стоп шире спасает сделку")

# Цена уходит на -1.4R, затем идёт в тейк. Стоп 1R убивает, стоп 1.5R — нет.
h, l, c = bars([(101, 86, 88), (105, 87, 104), (125, 103, 124)])
narrow = replay(h, l, c, 0, "long", 100, 90, 120, 10)
wide = replay(h, l, c, 0, "long", 100, 85, 120, 10)
check("узкий стоп -> sl", narrow.outcome == "sl", f"-> {narrow}")
check("широкий стоп -> tp", wide.outcome == "tp", f"-> {wide}")

print("find_bar_index")

t = np.array([0, 300_000, 600_000, 900_000], dtype=np.int64)
check("момент внутри свечи", find_bar_index(t, 700_000, 300_000) == 2)
check("момент на границе свечи", find_bar_index(t, 600_000, 300_000) == 2)
check("момент до начала данных", find_bar_index(t, -1, 300_000) is None)
check("момент за концом данных", find_bar_index(t, 5_000_000, 300_000) is None)

print("to_epoch_ms: разрешение datetime не должно влиять на результат")

import pandas as pd  # noqa: E402

EXPECTED = 1773164100000  # 2026-03-10 17:35:00 UTC в миллисекундах
for unit in ("s", "ms", "us", "ns"):
    ser = pd.Series(pd.to_datetime(["2026-03-10T17:35:00Z"])).astype(f"datetime64[{unit}, UTC]")
    got = int(to_epoch_ms(ser)[0])
    check(f"разрешение {unit}", got == EXPECTED, f"-> {got}, ждали {EXPECTED}")

# Из ISO-строк, как приходит из CSV
check("из ISO-строки", int(to_epoch_ms(pd.Series(["2026-03-10T17:35:00+00:00"]))[0]) == EXPECTED)

print()
if FAILURES:
    print(f"ПРОВАЛЕНО: {len(FAILURES)} -> {FAILURES}")
    sys.exit(1)
print("Все тесты реплея прошли.")

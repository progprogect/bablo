import { useEffect, useState } from "react";
import { getWithdrawals } from "../../api/client";
import type { WithdrawalsState, WithdrawalView } from "../../api/types";

function formatUsd(value: number): string {
  return value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

/** «1 вывод», «2 вывода», «5 выводов» — иначе подстрочник читается как машинный. */
function pluralWithdrawals(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} выводов`;
  if (mod10 === 1) return `${count} вывод`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} вывода`;
  return `${count} выводов`;
}

/**
 * Строка одного вывода. Сумма «требовалось» отдельно не показывается: она сверяется до
 * цента (docs/RISK_ENGINE.md, правило #12), поэтому у выполненного вывода всегда равна
 * фактической — вторая одинаковая цифра только шумела бы.
 */
function WithdrawalRow({ entry }: { entry: WithdrawalView }) {
  const done = entry.withdrawnAt !== null;
  return (
    <li className="flex items-baseline justify-between gap-2 py-1.5 text-xs">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-slate-600">Уровень {entry.level}</span>
        <span className="text-[11px] text-slate-400">
          {done && entry.withdrawnAt
            ? `${formatDate(entry.withdrawnAt)}${entry.source === "bingx" ? " · сверено с BingX" : " · отмечено вручную"}`
            : "ждёт вывода"}
        </span>
      </span>
      <span className={`shrink-0 tabular-nums ${done ? "font-medium text-ink" : "text-amber-700"}`}>
        {formatUsd(done ? (entry.withdrawnUsd ?? entry.requiredUsd) : entry.requiredUsd)} USDT
      </span>
    </li>
  );
}

/**
 * Вкладка «Выводы» на экране «История» (просьба пользователя от 23.09.2026; до этого жила
 * карточкой на вкладке «Статистика»).
 *
 * Показывает то, ради чего вся торговля: сколько РЕАЛЬНЫХ денег снято с биржи по правилу
 * #12 (docs/RISK_ENGINE.md) — прибыль на счёте это ещё не деньги, деньги это вывод.
 *
 * Вкладка намеренно read-only. Подтверждать вывод (сверка с BingX / ручная отметка) можно
 * на дашборде, где требование и блокирует торговлю: два места управления одним и тем же
 * состоянием разъезжаются, а читать историю удобнее здесь.
 */
export function WithdrawalsCard() {
  const [state, setState] = useState<WithdrawalsState | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    getWithdrawals()
      .then(setState)
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return <p className="px-2 text-center text-sm text-slate-500">Не удалось загрузить выводы.</p>;
  }
  if (!state) {
    return <p className="px-2 text-center text-sm text-slate-500">Загрузка…</p>;
  }

  const done = state.history.filter((entry) => entry.withdrawnAt !== null);
  const pending = state.history.filter((entry) => entry.withdrawnAt === null);
  // История отсортирована по уровню; последним по времени считаем самую позднюю дату.
  const lastAt = done.reduce<string | null>(
    (latest, entry) =>
      entry.withdrawnAt && (latest === null || entry.withdrawnAt > latest) ? entry.withdrawnAt : latest,
    null,
  );

  // Пустое состояние: у отдельной вкладки оно обязано объяснять правило, а не быть белым
  // экраном (карточка на «Статистике» в этом случае просто не рисовалась).
  if (state.history.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 shadow-sm">
        <h3 className="text-sm font-medium text-ink">Выводов пока не было</h3>
        <p className="text-xs leading-relaxed text-slate-500">
          На каждом повышении уровня появляется требование вывести часть прибыли за пройденный
          уровень — 2R, а с 22-го уровня 3R. Пока вывод не подтверждён, новые сделки не
          открываются. Здесь будет история: сколько, когда и за какой уровень снято.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1 rounded-2xl border border-line bg-card p-4 shadow-sm">
        <span className="text-xs text-slate-500">Снято с биржи</span>
        <span className="text-2xl font-semibold tabular-nums text-emerald-600">
          {formatUsd(state.totalWithdrawnUsd)} USDT
        </span>
        <span className="text-xs text-slate-400">
          {done.length > 0
            ? `${pluralWithdrawals(done.length)}${lastAt ? ` · последний ${formatDate(lastAt)}` : ""}`
            : "ни один вывод ещё не подтверждён"}
        </span>
      </div>

      {/* Незакрытое требование блокирует торговлю — оно должно быть заметным, а не строкой
          в общем списке. Подтверждается на дашборде, поэтому здесь только напоминание. */}
      {pending.length > 0 && (
        <div className="flex flex-col gap-1 rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <span className="text-sm font-medium text-amber-900">
            {pending.length === 1 ? "Нужно вывести" : "Нужно вывести за несколько уровней"}
          </span>
          <ul className="flex flex-col gap-0.5">
            {pending.map((entry) => (
              <li key={entry.id} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-amber-800">Уровень {entry.level}</span>
                <span className="font-medium tabular-nums text-amber-900">
                  {formatUsd(entry.requiredUsd)} USDT
                </span>
              </li>
            ))}
          </ul>
          <span className="text-[11px] leading-snug text-amber-700">
            Пока вывод не подтверждён, сделки не открываются. Подтвердить — на дашборде.
          </span>
        </div>
      )}

      {done.length > 0 && (
        <div className="flex flex-col gap-1 rounded-2xl border border-line bg-card p-4 shadow-sm">
          <h3 className="text-sm font-medium text-ink">История выводов</h3>
          <ul className="flex flex-col divide-y divide-line">
            {done.map((entry) => (
              <WithdrawalRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

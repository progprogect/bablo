import { useEffect, useState } from "react";
import { getWithdrawals } from "../../api/client";
import type { WithdrawalsState, WithdrawalView } from "../../api/types";

function formatUsd(value: number): string {
  return value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function WithdrawalRow({ entry }: { entry: WithdrawalView }) {
  const done = entry.withdrawnAt !== null;
  return (
    <li className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-slate-500">
        Уровень {entry.level}
        {done && entry.withdrawnAt ? ` · ${formatDate(entry.withdrawnAt)}` : " · ждёт вывода"}
      </span>
      <span className={`tabular-nums ${done ? "font-medium text-ink" : "text-amber-700"}`}>
        {formatUsd(done ? (entry.withdrawnUsd ?? entry.requiredUsd) : entry.requiredUsd)} USDT
      </span>
    </li>
  );
}

/**
 * Сколько реальных денег снято с биржи (docs/RISK_ENGINE.md, правило #12) — то, ради чего
 * вся торговля: прибыль на счёте это ещё не деньги, деньги это вывод. Показываем сумму
 * всех выводов и список по уровням, включая ещё не сделанный вывод.
 */
export function WithdrawalsCard() {
  const [state, setState] = useState<WithdrawalsState | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    getWithdrawals()
      .then(setState)
      .catch(() => setState(null));
  }, []);

  if (!state || (state.history.length === 0 && state.totalWithdrawnUsd === 0)) return null;

  const visible = expanded ? state.history : state.history.slice(0, 3);

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-ink">Выведено с биржи</h3>
        <span className="text-base font-semibold tabular-nums text-emerald-600">
          {formatUsd(state.totalWithdrawnUsd)} USDT
        </span>
      </div>
      <p className="text-xs text-slate-500">
        Реальные деньги, снятые с биржи после пройденных уровней.
      </p>

      <ul className="mt-1 flex flex-col gap-1.5">
        {visible.map((entry) => (
          <WithdrawalRow key={entry.id} entry={entry} />
        ))}
      </ul>

      {state.history.length > 3 && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="self-start text-xs font-medium text-accent underline-offset-2 hover:underline"
        >
          {expanded ? "свернуть" : `показать все (${state.history.length})`}
        </button>
      )}
    </div>
  );
}

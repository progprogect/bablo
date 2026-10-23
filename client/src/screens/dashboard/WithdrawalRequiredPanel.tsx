import { useState } from "react";
import { ApiError, confirmWithdrawalRequest } from "../../api/client";
import type { PendingWithdrawal } from "../../api/types";

function formatUsd(value: number): string {
  return value.toFixed(2);
}

/**
 * Блокировка «выведи прибыль за пройденный уровень» (docs/RISK_ENGINE.md, правило #12).
 * В отличие от остальных блокировок, она снимается не по таймеру, а действием: выводом
 * денег с биржи. Поэтому здесь не обратный отсчёт, а подтверждение вывода.
 *
 * Путь подтверждения ОДИН — ручная отметка (просьба пользователя от 18.10.2026). Кнопка
 * автоматической сверки с историей выводов BingX убрана: историю выводов видит только ключ
 * с правами на кошелёк, таких прав у ключа нет, и на практике сверка не срабатывала
 * никогда — кнопка лишь занимала место и обещала то, чего не умеет. Серверная ручка
 * `POST /api/withdrawals/check-bingx` оставлена на случай, если права когда-нибудь выдадут.
 */
export function WithdrawalRequiredPanel({
  pending,
  onResolved,
}: {
  pending: PendingWithdrawal[];
  onResolved: () => void;
}) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [manualFor, setManualFor] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  const total = pending.reduce((sum, entry) => sum + entry.requiredUsd, 0);

  async function handleConfirm(entry: PendingWithdrawal) {
    setError(null);
    setIsConfirming(true);
    try {
      await confirmWithdrawalRequest(entry.id, Number(amount));
      onResolved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось подтвердить вывод");
    } finally {
      setIsConfirming(false);
    }
  }

  function openManual(entry: PendingWithdrawal) {
    setManualFor(entry.id);
    setAmount(formatUsd(entry.requiredUsd));
    setError(null);
  }

  return (
    <div className="mx-4 flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-amber-800">
          {pending.length === 1
            ? `Пройден уровень ${pending[0]!.level} — выведи ${formatUsd(total)} USDT`
            : `Не выведена прибыль за ${pending.length} уровня — всего ${formatUsd(total)} USDT`}
        </p>
        <p className="text-xs text-amber-700">
          Прибыль становится реальными деньгами только после вывода с биржи. Сумма — 2R
          пройденного уровня (с 10-го уровня 3R), до цента. Пока вывод не подтверждён,
          открытие сделок закрыто.
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {pending.map((entry) => (
          <li key={entry.id} className="flex flex-col gap-2 rounded-xl bg-card p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-slate-500">Уровень {entry.level}</span>
              <span className="text-sm font-semibold tabular-nums text-ink">
                {formatUsd(entry.requiredUsd)} USDT
              </span>
            </div>

            {manualFor === entry.id ? (
              <div className="flex flex-col gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className="rounded-xl border border-line bg-surface px-4 py-2.5 text-center text-ink outline-none focus:border-accent"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={isConfirming}
                    onClick={() => handleConfirm(entry)}
                    className="flex-1 rounded-xl bg-accent py-2.5 text-sm font-medium text-surface disabled:opacity-50"
                  >
                    {isConfirming ? "Сохраняю…" : "Я вывела эту сумму"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setManualFor(null)}
                    className="rounded-xl border border-line px-4 py-2.5 text-sm text-slate-600"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => openManual(entry)}
                className="self-start text-xs font-medium text-accent underline-offset-2 hover:underline"
              >
                Отметить вывод вручную
              </button>
            )}
          </li>
        ))}
      </ul>

      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

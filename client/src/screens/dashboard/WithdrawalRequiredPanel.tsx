import { useState } from "react";
import { ApiError, checkBingxWithdrawalsRequest, confirmWithdrawalRequest } from "../../api/client";
import type { PendingWithdrawal } from "../../api/types";

function formatUsd(value: number): string {
  return value.toFixed(2);
}

/**
 * Блокировка «выведи прибыль за пройденный уровень» (docs/RISK_ENGINE.md, правило #12).
 * В отличие от остальных блокировок, она снимается не по таймеру, а действием: выводом
 * денег с биржи. Поэтому здесь не обратный отсчёт, а два пути подтверждения —
 * автоматическая сверка с историей выводов BingX и ручная отметка.
 */
export function WithdrawalRequiredPanel({
  pending,
  onResolved,
}: {
  pending: PendingWithdrawal[];
  onResolved: () => void;
}) {
  const [isChecking, setIsChecking] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [manualFor, setManualFor] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const total = pending.reduce((sum, entry) => sum + entry.requiredUsd, 0);

  async function handleCheck() {
    setError(null);
    setNotice(null);
    setIsChecking(true);
    try {
      const result = await checkBingxWithdrawalsRequest();
      if (result.error) {
        setError(
          `${result.error}. Историю выводов видит только ключ с правами на кошелёк — ` +
            "либо выдай их ключу в BingX, либо отметь вывод вручную.",
        );
      } else if (result.matched > 0) {
        onResolved();
      } else {
        setNotice(
          `Подходящего вывода не нашлось (проверено записей: ${result.found}). ` +
            "Вывод должен быть на точную сумму и сделан после прохождения уровня.",
        );
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось проверить выводы на BingX");
    } finally {
      setIsChecking(false);
    }
  }

  async function handleConfirm(entry: PendingWithdrawal) {
    setError(null);
    setNotice(null);
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
    setNotice(null);
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
          Прибыль становится реальными деньгами только после вывода с биржи. Сумма — ровно 1R
          пройденного уровня, до цента. Пока вывод не подтверждён, открытие сделок закрыто.
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

      <button
        type="button"
        disabled={isChecking}
        onClick={handleCheck}
        className="rounded-xl border border-amber-300 bg-card py-2.5 text-sm font-medium text-amber-800 disabled:opacity-50"
      >
        {isChecking ? "Проверяю на BingX…" : "Проверить вывод на BingX"}
      </button>

      {notice && <p className="text-xs text-amber-700">{notice}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

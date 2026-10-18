import { useEffect, useState } from "react";
import { ApiError, getEquityHistory, getWithdrawals } from "../../api/client";
import type { EquitySnapshot } from "../../api/types";
import { EquityChart, type WithdrawalMark } from "./EquityChart";

/**
 * Полноэкранный шит с графиком роста депозита — явное исключение из принципа
 * "без графиков" (docs/PROJECT.md), подтверждённое пользователем. Открывается только
 * по кнопке со вкладки "Статистика", не занимает место на основном экране истории.
 */
export function EquityHistorySheet({ onClose }: { onClose: () => void }) {
  const [snapshots, setSnapshots] = useState<EquitySnapshot[] | null>(null);
  const [withdrawals, setWithdrawals] = useState<WithdrawalMark[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getEquityHistory()
      .then(setSnapshots)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить историю депозита"));
  }, []);

  // Выводы грузятся отдельно и best-effort: это отметки ПОВЕРХ графика, и если запрос
  // не прошёл, график обязан нарисоваться без них, а не показать ошибку целиком.
  useEffect(() => {
    getWithdrawals()
      .then((state) =>
        setWithdrawals(
          state.history
            .filter((entry) => entry.withdrawnAt !== null)
            .map((entry) => ({
              at: entry.withdrawnAt!,
              // Фактическая сумма, а не требуемая: на графике отмечаем снятые деньги.
              amountUsd: entry.withdrawnUsd ?? entry.requiredUsd,
            })),
        ),
      )
      .catch(() => setWithdrawals([]));
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-surface">
      <div
        className="flex items-center justify-between border-b border-line px-4 pb-3"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 16px)" }}
      >
        <h2 className="text-base font-medium text-ink">Рост депозита</h2>
        <button type="button" onClick={onClose} className="text-sm text-slate-500">
          Закрыть
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {error ? (
          <p className="text-center text-sm text-red-600">{error}</p>
        ) : snapshots === null ? (
          <p className="text-center text-sm text-slate-500">Загрузка…</p>
        ) : (
          <div className="rounded-2xl border border-line bg-card p-4 shadow-sm">
            <EquityChart snapshots={snapshots} withdrawals={withdrawals} />
          </div>
        )}
        <p className="mt-3 text-center text-xs text-slate-400">
          Один снимок баланса в день. График растёт со дня первого снимка — данные до этого
          момента не восстанавливаются.
        </p>
      </div>
    </div>
  );
}

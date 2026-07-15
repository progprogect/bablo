import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  createEquityAdjustmentRequest,
  deleteEquityAdjustmentRequest,
  getEquityAdjustments,
  type EquityAdjustment,
} from "../../api/client";
import { trimTrailingZeros } from "../../lib/format";

function todayDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function EquityAdjustmentsSection() {
  const [items, setItems] = useState<EquityAdjustment[] | null>(null);
  const [date, setDate] = useState(todayDateKey());
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState<"deposit" | "withdrawal">("deposit");
  const [note, setNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reload() {
    getEquityAdjustments()
      .then(setItems)
      .catch(() => setItems([]));
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Укажите сумму больше нуля");
      return;
    }

    setError(null);
    setIsSaving(true);
    try {
      const amountUsd = kind === "deposit" ? parsed : -parsed;
      await createEquityAdjustmentRequest({ date, amountUsd, note: note.trim() || undefined });
      setAmount("");
      setNote("");
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("Удалить эту запись?")) return;
    try {
      await deleteEquityAdjustmentRequest(id);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось удалить");
    }
  }

  return (
    <section className="flex flex-col gap-3 border-b border-line pb-6">
      <div>
        <h2 className="text-sm font-medium text-ink">Пополнения и выводы</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Не связаны с результатом торговли — нужны, чтобы % к депозиту за прошлые месяцы
          в «Статистике» считался верно (баланс восстанавливается от текущего назад по
          истории сделок и этим записям).
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setKind("deposit")}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
              kind === "deposit" ? "border-accent bg-accent/10 text-accent" : "border-line text-slate-500"
            }`}
          >
            Пополнение
          </button>
          <button
            type="button"
            onClick={() => setKind("withdrawal")}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
              kind === "withdrawal" ? "border-accent bg-accent/10 text-accent" : "border-line text-slate-500"
            }`}
          >
            Вывод
          </button>
        </div>
        <div className="flex gap-2">
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
          />
          <input
            type="number"
            inputMode="decimal"
            placeholder="Сумма, USDT"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
          />
        </div>
        <input
          type="text"
          placeholder="Заметка (необязательно)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />

        {error && <p className="text-xs text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={isSaving || !amount.trim()}
          className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Добавить
        </button>
      </form>

      {items === null ? (
        <p className="text-xs text-slate-400">Загрузка…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-slate-400">Записей нет</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => {
            const value = Number(item.amountUsd);
            const isDeposit = value > 0;
            return (
              <li
                key={item.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm"
              >
                <div className="flex flex-col">
                  <span className="text-ink">
                    {item.date} · {isDeposit ? "пополнение" : "вывод"}
                  </span>
                  {item.note && <span className="text-xs text-slate-500">{item.note}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <span className={isDeposit ? "font-medium text-emerald-600" : "font-medium text-red-600"}>
                    {isDeposit ? "+" : ""}
                    {trimTrailingZeros(value)} USDT
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDelete(item.id)}
                    className="text-xs text-slate-400 hover:text-red-600"
                  >
                    Удалить
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

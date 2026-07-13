import { useState, type FormEvent } from "react";
import { ApiError, setupPin } from "../../api/client";

const PIN_PATTERN = /^\d{4,8}$/;

export function PinSetup({ onDone }: { onDone: () => void }) {
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!PIN_PATTERN.test(pin)) {
      setError("PIN должен содержать от 4 до 8 цифр");
      return;
    }
    if (pin !== confirmPin) {
      setError("PIN-коды не совпадают");
      return;
    }

    setIsSubmitting(true);
    try {
      await setupPin(pin);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить PIN");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-6 bg-surface px-6">
      <div className="text-center">
        <h1 className="text-lg font-medium text-ink">Установите PIN</h1>
        <p className="mt-1 text-sm text-slate-500">Он будет нужен для входа в приложение</p>
      </div>

      <form onSubmit={handleSubmit} className="flex w-full max-w-xs flex-col gap-3">
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          placeholder="Новый PIN"
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
          maxLength={8}
          className="rounded-xl border border-line bg-card px-4 py-3 text-center text-xl tracking-[0.4em] text-ink outline-none focus:border-accent"
        />
        <input
          type="password"
          inputMode="numeric"
          placeholder="Повторите PIN"
          value={confirmPin}
          onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ""))}
          maxLength={8}
          className="rounded-xl border border-line bg-card px-4 py-3 text-center text-xl tracking-[0.4em] text-ink outline-none focus:border-accent"
        />

        {error && <p className="text-center text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-1 rounded-xl bg-accent px-4 py-3 font-medium text-white disabled:opacity-50"
        >
          Сохранить
        </button>
      </form>
    </section>
  );
}

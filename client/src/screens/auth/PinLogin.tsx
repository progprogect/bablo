import { useState, type FormEvent } from "react";
import { ApiError, loginPin } from "../../api/client";

export function PinLogin({ onDone }: { onDone: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await loginPin(pin);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось войти");
      setPin("");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
      <h1 className="text-lg font-medium text-slate-100">Bablo</h1>

      <form onSubmit={handleSubmit} className="flex w-full max-w-xs flex-col gap-3">
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          placeholder="PIN"
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
          maxLength={8}
          className="rounded-xl border border-slate-800 bg-transparent px-4 py-3 text-center text-xl tracking-[0.4em] text-slate-100 outline-none focus:border-accent"
        />

        {error && <p className="text-center text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={isSubmitting || pin.length < 4}
          className="mt-1 rounded-xl bg-accent px-4 py-3 font-medium text-surface disabled:opacity-50"
        >
          Войти
        </button>
      </form>
    </section>
  );
}

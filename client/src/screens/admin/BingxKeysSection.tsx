import { useEffect, useState, type FormEvent } from "react";
import { ApiError, getBingxKeyStatus, saveBingxKey } from "../../api/client";

export function BingxKeysSection() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedEquity, setCheckedEquity] = useState<string | null>(null);

  useEffect(() => {
    getBingxKeyStatus()
      .then((status) => setConfigured(status.configured))
      .catch(() => setConfigured(false));
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setCheckedEquity(null);
    setIsSaving(true);
    try {
      const result = await saveBingxKey(apiKey.trim(), secretKey.trim());
      setConfigured(true);
      setCheckedEquity(result.balance.equity);
      setSecretKey("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось проверить ключи");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 border-b border-slate-800 pb-6">
      <div>
        <h2 className="text-sm font-medium text-slate-100">BingX API</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          {configured === null
            ? "Проверка…"
            : configured
              ? "Ключи подключены"
              : "Ключи не настроены"}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <input
          type="text"
          placeholder="API Key"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          className="rounded-lg border border-slate-800 bg-transparent px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
        />
        <input
          type="password"
          placeholder="Secret Key"
          value={secretKey}
          onChange={(event) => setSecretKey(event.target.value)}
          className="rounded-lg border border-slate-800 bg-transparent px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
        />

        {error && <p className="text-xs text-red-400">{error}</p>}
        {checkedEquity && (
          <p className="text-xs text-emerald-400">Подключено. Баланс: {checkedEquity} USDT</p>
        )}

        <button
          type="submit"
          disabled={isSaving || !apiKey.trim() || !secretKey.trim()}
          className="mt-1 self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface disabled:opacity-50"
        >
          Проверить и сохранить
        </button>
      </form>
    </section>
  );
}

import { useEffect, useState, type FormEvent } from "react";
import { ApiError, getBingxKeyStatus, saveBingxKey } from "../../api/client";

type SaveBingxKeyResponse = {
  configured: boolean;
  balance?: { equity?: string; balance?: string };
  equity?: string | null;
};

function pickEquity(result: SaveBingxKeyResponse | null | undefined): string | null {
  if (!result) return null;
  const raw = result.equity ?? result.balance?.equity ?? result.balance?.balance;
  return raw != null && raw !== "" ? String(raw) : null;
}

export function BingxKeysSection() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    getBingxKeyStatus()
      .then((status) => setConfigured(status.configured))
      .catch(() => setConfigured(false));
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setIsSaving(true);
    try {
      const result = (await saveBingxKey(apiKey.trim(), secretKey.trim())) as SaveBingxKeyResponse;
      setConfigured(true);
      setSecretKey("");
      const equity = pickEquity(result);
      setSuccess(equity ? `Подключено. Баланс: ${equity} USDT` : "Ключи сохранены и проверены");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        return;
      }
      // Ответ мог не распарситься на мобильном клиенте, хотя сервер уже сохранил ключи.
      try {
        const status = await getBingxKeyStatus();
        setConfigured(status.configured);
        if (status.configured) {
          setSuccess("Ключи сохранены");
          setError(null);
        } else {
          setError("Не удалось подтвердить сохранение ключей — попробуйте ещё раз");
        }
      } catch {
        setError("Не удалось проверить ключи — попробуйте ещё раз");
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 border-b border-line pb-6">
      <div>
        <h2 className="text-sm font-medium text-ink">BingX API</h2>
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
          className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />
        <input
          type="password"
          placeholder="Secret Key"
          value={secretKey}
          onChange={(event) => setSecretKey(event.target.value)}
          className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />

        {error && <p className="text-xs text-red-600">{error}</p>}
        {success && <p className="text-xs text-emerald-600">{success}</p>}

        <button
          type="submit"
          disabled={isSaving || !apiKey.trim() || !secretKey.trim()}
          className="mt-1 self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Проверить и сохранить
        </button>
      </form>
    </section>
  );
}

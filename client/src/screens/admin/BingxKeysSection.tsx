import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  getBingxKeyStatus,
  reclassifyTrades,
  resetAccountData,
  saveBingxKey,
  type ReclassifyTradeDetail,
} from "../../api/client";

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
  const [isResetting, setIsResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState<string | null>(null);
  const [isReclassifying, setIsReclassifying] = useState(false);
  const [reclassifyError, setReclassifyError] = useState<string | null>(null);
  const [reclassifySuccess, setReclassifySuccess] = useState<string | null>(null);
  const [reclassifyDetails, setReclassifyDetails] = useState<ReclassifyTradeDetail[] | null>(null);

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

  async function handleReset() {
    const confirmed = window.confirm(
      "Удалить всю историю сделок, дневную статистику и сбросить прогресс риск-плана к уровню 1?\n\n" +
        "Ключи BingX это не затронет. Действие нельзя отменить — используйте перед подключением другого аккаунта.",
    );
    if (!confirmed) return;

    setResetError(null);
    setResetSuccess(null);
    setIsResetting(true);
    try {
      const result = await resetAccountData();
      setResetSuccess(`Данные очищены (удалено сделок: ${result.tradesDeleted})`);
    } catch (err) {
      setResetError(err instanceof ApiError ? err.message : "Не удалось очистить данные");
    } finally {
      setIsResetting(false);
    }
  }

  async function handleReclassify() {
    setReclassifyError(null);
    setReclassifySuccess(null);
    setReclassifyDetails(null);
    setIsReclassifying(true);
    try {
      const result = await reclassifyTrades();
      setReclassifySuccess(
        result.fixed > 0
          ? `Исправлено ${result.fixed} из ${result.checked} сделок`
          : `Проверено ${result.checked} сделок — исправлений не потребовалось`,
      );
      setReclassifyDetails(result.details);
    } catch (err) {
      setReclassifyError(err instanceof ApiError ? err.message : "Не удалось пересчитать сделки");
    } finally {
      setIsReclassifying(false);
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

      <div className="mt-2 flex flex-col gap-1.5 border-t border-line pt-3">
        <p className="text-xs text-slate-500">
          Пересверить закрытые сделки с BingX — исправит причину закрытия (SL/TP) у тех
          сделок, что раньше записались как «внешние» из-за бага сверки.
        </p>
        <button
          type="button"
          disabled={isReclassifying}
          onClick={handleReclassify}
          className="self-start rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-50"
        >
          {isReclassifying ? "Проверяю…" : "Пересверить закрытые сделки"}
        </button>
        {reclassifyError && <p className="text-xs text-red-600">{reclassifyError}</p>}
        {reclassifySuccess && <p className="text-xs text-emerald-600">{reclassifySuccess}</p>}
        {reclassifyDetails && reclassifyDetails.length > 0 && (
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer select-none text-accent">Диагностика по сделкам</summary>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-lg bg-surface p-2 text-[10px] leading-tight">
              {JSON.stringify(reclassifyDetails, null, 2)}
            </pre>
          </details>
        )}
      </div>

      <div className="mt-2 flex flex-col gap-1.5 border-t border-line pt-3">
        <p className="text-xs text-slate-500">
          Перед подключением другого аккаунта очистите историю сделок и прогресс риск-плана —
          иначе они останутся от старого аккаунта.
        </p>
        <button
          type="button"
          disabled={isResetting}
          onClick={handleReset}
          className="self-start rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-50"
        >
          {isResetting ? "Очищаю…" : "Очистить данные для нового аккаунта"}
        </button>
        {resetError && <p className="text-xs text-red-600">{resetError}</p>}
        {resetSuccess && <p className="text-xs text-emerald-600">{resetSuccess}</p>}
      </div>
    </section>
  );
}

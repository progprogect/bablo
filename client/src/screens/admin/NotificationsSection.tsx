import { useEffect, useState } from "react";
import { ApiError, getPushPublicKey, subscribePushRequest, unsubscribePushRequest } from "../../api/client";

/** VAPID public key приходит в base64url — PushManager ждёт Uint8Array. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

type PushState = "checking" | "unsupported" | "off" | "on";

/**
 * Включение push-уведомлений о закрытии сделки НА ЭТОМ УСТРОЙСТВЕ. Каждое устройство
 * подписывается отдельно (подписка живёт в браузере/PWA), сервер хранит список подписок
 * и шлёт на все. На iPhone работает только из PWA, добавленного на экран «Домой» (iOS 16.4+).
 */
export function NotificationsSection() {
  const [state, setState] = useState<PushState>("checking");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isPushSupported()) {
      setState("unsupported");
      return;
    }
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setState(subscription ? "on" : "off"))
      .catch(() => setState("off"));
  }, []);

  async function handleEnable() {
    setError(null);
    setIsBusy(true);
    try {
      // requestPermission обязан вызываться из жеста пользователя (особенно iOS).
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setError("Разрешение на уведомления не выдано. Проверь настройки уведомлений для приложения.");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const { publicKey } = await getPushPublicKey();
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
      await subscribePushRequest(subscription.toJSON());
      setState("on");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось включить уведомления");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleDisable() {
    setError(null);
    setIsBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await unsubscribePushRequest(endpoint);
      }
      setState("off");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось отключить уведомления");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 border-b border-line pb-6">
      <div>
        <h2 className="text-sm font-medium text-ink">Уведомления</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Push о закрытии сделки на это устройство — со звуком, даже когда приложение
          закрыто. На iPhone работает только из приложения, добавленного на экран «Домой»
          (iOS 16.4+). Внутри открытого приложения дополнительно звучит сигнал.
        </p>
      </div>

      {state === "checking" && <p className="text-xs text-slate-400">Проверка…</p>}

      {state === "unsupported" && (
        <p className="text-xs text-slate-500">
          Этот браузер не поддерживает push-уведомления. На iPhone: добавь приложение на
          экран «Домой» и открой его оттуда.
        </p>
      )}

      {state === "off" && (
        <button
          type="button"
          onClick={handleEnable}
          disabled={isBusy}
          className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Включить на этом устройстве
        </button>
      )}

      {state === "on" && (
        <div className="flex items-center gap-3">
          <p className="text-sm text-emerald-600">Уведомления включены</p>
          <button
            type="button"
            onClick={handleDisable}
            disabled={isBusy}
            className="text-xs text-slate-400 hover:text-red-600"
          >
            Отключить
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
    </section>
  );
}

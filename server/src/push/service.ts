import webpush from "web-push";
import {
  getPushSubscriptions,
  getPushVapidKeys,
  setPushSubscriptions,
  setPushVapidKeys,
  type PushVapidKeys,
  type StoredPushSubscription,
} from "../db/repositories/settings.js";
import { resolveTradeOutcome, roundStatsR, type TradeForOutcome } from "../history/outcome.js";

/**
 * Web Push об окончании сделки — чтобы на iPhone (PWA с экрана «Домой», iOS 16.4+)
 * приходило системное уведомление со звуком, даже когда приложение закрыто.
 *
 * Всё состояние в kv-таблице settings (без миграций): VAPID-ключи генерируются один раз
 * при первом обращении, подписки добавляет каждое устройство через админку.
 */

/**
 * VAPID subject — контакт для push-сервисов Apple/Google на случай проблем с трафиком.
 * Нейтральный адрес, привязки к домену приложения нет (домен Railway может меняться).
 */
const VAPID_SUBJECT = "mailto:admin@bablo.app";

let cachedKeys: PushVapidKeys | null = null;

export async function getOrCreateVapidKeys(): Promise<PushVapidKeys> {
  if (cachedKeys) {
    return cachedKeys;
  }
  const stored = await getPushVapidKeys();
  if (stored) {
    cachedKeys = stored;
    return stored;
  }
  // Ключи должны пережить рестарты (иначе все подписки устройств умрут) — сразу в БД.
  const generated = webpush.generateVAPIDKeys();
  const keys: PushVapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
  await setPushVapidKeys(keys);
  cachedKeys = keys;
  return keys;
}

export async function addPushSubscription(subscription: StoredPushSubscription): Promise<void> {
  const existing = await getPushSubscriptions();
  const withoutSame = existing.filter((item) => item.endpoint !== subscription.endpoint);
  await setPushSubscriptions([...withoutSame, subscription]);
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  const existing = await getPushSubscriptions();
  const remaining = existing.filter((item) => item.endpoint !== endpoint);
  if (remaining.length !== existing.length) {
    await setPushSubscriptions(remaining);
  }
}

export type PushPayload = {
  title: string;
  body: string;
};

/**
 * Рассылает уведомление на все подписанные устройства. Ошибки не пробрасывает:
 * push — best-effort, закрытие сделки от него зависеть не должно. Протухшие подписки
 * (404/410 от push-сервиса) удаляются, чтобы не копить мёртвые endpoint'ы.
 */
export async function sendPushToAll(payload: PushPayload): Promise<void> {
  let subscriptions: StoredPushSubscription[];
  try {
    subscriptions = await getPushSubscriptions();
  } catch (error) {
    console.warn("[push] не удалось прочитать подписки:", error);
    return;
  }
  if (subscriptions.length === 0) {
    return;
  }

  const keys = await getOrCreateVapidKeys();
  const body = JSON.stringify(payload);

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription, body, {
          vapidDetails: { subject: VAPID_SUBJECT, ...keys },
          // Сообщение о закрытии актуально недолго — не храним в очереди push-сервиса сутками.
          TTL: 3600,
        });
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await removePushSubscription(subscription.endpoint).catch(() => {});
          return;
        }
        console.warn(`[push] не удалось отправить уведомление (${statusCode ?? "?"}):`, error);
      }
    }),
  );
}

function displaySymbol(symbol: string): string {
  return symbol.replace(/-USDT$/, "");
}

function formatSignedR(resultR: number): string {
  const rounded = roundStatsR(resultR);
  const sign = rounded > 0 ? "+" : "";
  // toString у числа сам убирает хвостовые нули: 1.5 → "1.5", 2 → "2".
  return `${sign}${rounded}R`;
}

const OUTCOME_LABELS: Record<string, string> = {
  tp: "Тейк",
  sl: "Стоп",
  be: "Безубыток",
  other: "Закрыта",
};

/**
 * Уведомление «Сделка закрыта»: исход по той же логике, что и в истории/статистике
 * (resolveTradeOutcome), R округлён тем же шагом 0.5 — цифры в пуше и в приложении совпадают.
 */
export function sendTradeClosedPush(
  trade: TradeForOutcome & { symbol: string },
  resultR: number,
): void {
  const outcome = resolveTradeOutcome(trade, resultR);
  const label = OUTCOME_LABELS[outcome] ?? "Закрыта";
  const body =
    outcome === "be"
      ? `${displaySymbol(trade.symbol)} — ${label}`
      : `${displaySymbol(trade.symbol)} — ${label} ${formatSignedR(resultR)}`;

  void sendPushToAll({ title: "Сделка закрыта", body }).catch((error) => {
    console.warn("[push] рассылка о закрытии сделки не удалась:", error);
  });
}

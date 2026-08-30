import { eq } from "drizzle-orm";
import { getDb } from "../client.js";
import { settings } from "../schema.js";
import { decrypt, encrypt } from "../../security/encryption.js";
import type { BingXCredentials } from "../../bingx/client.js";

const PIN_HASH_KEY = "pin_hash";
const BINGX_CREDENTIALS_KEY = "bingx_credentials";
const RISK_SETTINGS_KEY = "risk_settings";
const PUSH_VAPID_KEYS_KEY = "push_vapid_keys";
const PUSH_SUBSCRIPTIONS_KEY = "push_subscriptions";

async function getValue<T>(key: string): Promise<T | null> {
  const db = getDb();
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}

async function setValue(key: string, value: unknown): Promise<void> {
  const db = getDb();
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function getPinHash(): Promise<string | null> {
  return getValue<string>(PIN_HASH_KEY);
}

export async function setPinHash(hash: string): Promise<void> {
  await setValue(PIN_HASH_KEY, hash);
}

type StoredBingxCredentials = {
  apiKeyEncrypted: string;
  secretKeyEncrypted: string;
};

export async function getBingxCredentials(): Promise<BingXCredentials | null> {
  const stored = await getValue<StoredBingxCredentials>(BINGX_CREDENTIALS_KEY);
  if (!stored) {
    return null;
  }
  return {
    apiKey: decrypt(stored.apiKeyEncrypted),
    secretKey: decrypt(stored.secretKeyEncrypted),
  };
}

export async function setBingxCredentials(credentials: BingXCredentials): Promise<void> {
  const stored: StoredBingxCredentials = {
    apiKeyEncrypted: encrypt(credentials.apiKey),
    secretKeyEncrypted: encrypt(credentials.secretKey),
  };
  await setValue(BINGX_CREDENTIALS_KEY, stored);
}

export type RiskSettings = {
  /** Пауза перед новой сделкой после закрытия любой сделки, в минутах. */
  cooldownMinutes: number;
  /** Дневной лимит убытка в R (отрицательное число), например -2. */
  dailyLossLimitR: number;
  /** Дневная цель прибыли в R (положительное число), например 3. */
  dailyProfitLimitR: number;
  /** Час локального сброса торгового дня, 0-23. */
  resetHour: number;
  /** Смещение локальной таймзоны от UTC в минутах, например 180 для UTC+3. */
  tzOffsetMinutes: number;
};

export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  cooldownMinutes: 60,
  dailyLossLimitR: -2,
  dailyProfitLimitR: 3,
  resetHour: 7,
  tzOffsetMinutes: 180,
};

export async function getRiskSettings(): Promise<RiskSettings> {
  const stored = await getValue<RiskSettings>(RISK_SETTINGS_KEY);
  return stored ?? DEFAULT_RISK_SETTINGS;
}

export async function setRiskSettings(settingsPatch: Partial<RiskSettings>): Promise<RiskSettings> {
  const current = await getRiskSettings();
  const merged: RiskSettings = { ...current, ...settingsPatch };
  await setValue(RISK_SETTINGS_KEY, merged);
  return merged;
}

// --- Web Push: VAPID-ключи и подписки устройств живут в том же kv, без миграций ---

export type PushVapidKeys = {
  publicKey: string;
  privateKey: string;
};

export async function getPushVapidKeys(): Promise<PushVapidKeys | null> {
  return getValue<PushVapidKeys>(PUSH_VAPID_KEYS_KEY);
}

export async function setPushVapidKeys(keys: PushVapidKeys): Promise<void> {
  await setValue(PUSH_VAPID_KEYS_KEY, keys);
}

/** Подписка в формате PushSubscription.toJSON() — ровно то, что нужно web-push. */
export type StoredPushSubscription = {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export async function getPushSubscriptions(): Promise<StoredPushSubscription[]> {
  return (await getValue<StoredPushSubscription[]>(PUSH_SUBSCRIPTIONS_KEY)) ?? [];
}

export async function setPushSubscriptions(subscriptions: StoredPushSubscription[]): Promise<void> {
  await setValue(PUSH_SUBSCRIPTIONS_KEY, subscriptions);
}

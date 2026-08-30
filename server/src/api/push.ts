import type { FastifyInstance } from "fastify";
import { requireAuth } from "./plugins/auth-guard.js";
import {
  addPushSubscription,
  getOrCreateVapidKeys,
  removePushSubscription,
} from "../push/service.js";
import type { StoredPushSubscription } from "../db/repositories/settings.js";

function isValidSubscription(value: unknown): value is StoredPushSubscription {
  if (typeof value !== "object" || value === null) return false;
  const sub = value as Partial<StoredPushSubscription>;
  return (
    typeof sub.endpoint === "string" &&
    sub.endpoint.startsWith("https://") &&
    typeof sub.keys === "object" &&
    sub.keys !== null &&
    typeof sub.keys.p256dh === "string" &&
    typeof sub.keys.auth === "string"
  );
}

/** Web Push: публичный VAPID-ключ и регистрация подписок устройств (см. push/service.ts). */
export async function registerPushRoutes(app: FastifyInstance): Promise<void> {
  app.get("/push/public-key", { preHandler: requireAuth }, async () => {
    const keys = await getOrCreateVapidKeys();
    return { publicKey: keys.publicKey };
  });

  app.post("/push/subscribe", { preHandler: requireAuth }, async (request, reply) => {
    const { subscription } = (request.body ?? {}) as { subscription?: unknown };
    if (!isValidSubscription(subscription)) {
      reply.code(400).send({ error: "Некорректная подписка" });
      return;
    }
    await addPushSubscription({
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime ?? null,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    });
    reply.code(204).send();
  });

  app.post("/push/unsubscribe", { preHandler: requireAuth }, async (request, reply) => {
    const { endpoint } = (request.body ?? {}) as { endpoint?: unknown };
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      reply.code(400).send({ error: "Не указан endpoint" });
      return;
    }
    await removePushSubscription(endpoint);
    reply.code(204).send();
  });
}

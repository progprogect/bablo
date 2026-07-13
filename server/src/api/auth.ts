import type { FastifyInstance, FastifyReply } from "fastify";
import { getPinHash, setPinHash } from "../db/repositories/settings.js";
import { hashPin, verifyPin } from "../security/pin.js";
import { createSessionToken, SESSION_COOKIE_NAME, verifySessionToken } from "../security/session.js";
import { env } from "../config/env.js";

const PIN_PATTERN = /^\d{4,8}$/;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

const authRateLimit = { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } };

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/auth/status", async (request) => {
    const pinHash = await getPinHash();
    const token = request.cookies[SESSION_COOKIE_NAME];
    return {
      hasPin: pinHash !== null,
      authenticated: verifySessionToken(token),
    };
  });

  app.post<{ Body: { pin?: string } }>("/auth/setup", authRateLimit, async (request, reply) => {
    const existing = await getPinHash();
    if (existing) {
      reply.code(409).send({ error: "PIN уже установлен" });
      return;
    }

    const { pin } = request.body ?? {};
    if (!pin || !PIN_PATTERN.test(pin)) {
      reply.code(400).send({ error: "PIN должен содержать от 4 до 8 цифр" });
      return;
    }

    await setPinHash(await hashPin(pin));
    setSessionCookie(reply, createSessionToken());
    return { authenticated: true };
  });

  app.post<{ Body: { pin?: string } }>("/auth/pin", authRateLimit, async (request, reply) => {
    const existing = await getPinHash();
    if (!existing) {
      reply.code(409).send({ error: "PIN ещё не установлен" });
      return;
    }

    const { pin } = request.body ?? {};
    if (!pin || !(await verifyPin(pin, existing))) {
      reply.code(401).send({ error: "Неверный PIN" });
      return;
    }

    setSessionCookie(reply, createSessionToken());
    return { authenticated: true };
  });

  app.post("/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return { authenticated: false };
  });
}

import { createHmac, timingSafeEqual } from "node:crypto";
import { requireSessionSecret } from "../config/env.js";

export const SESSION_COOKIE_NAME = "bablo_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

type SessionPayload = { exp: number };

function sign(encodedPayload: string): string {
  return createHmac("sha256", requireSessionSecret()).update(encodedPayload).digest("hex");
}

/**
 * Сессия — подписанная кука без серверного стейта (single-user приложение,
 * не нужна таблица сессий). Валидна, пока не истёк exp и подпись верна.
 */
export function createSessionToken(): string {
  const payload: SessionPayload = { exp: Date.now() + SESSION_TTL_MS };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) {
    return false;
  }
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return false;
  }

  const expectedSignature = sign(encodedPayload);
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expectedSignature, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString()) as SessionPayload;
    return typeof payload.exp === "number" && payload.exp > Date.now();
  } catch {
    return false;
  }
}

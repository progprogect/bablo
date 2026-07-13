import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Загружаем .env из корня монорепо независимо от текущей рабочей директории
// (npm workspaces запускают скрипты с cwd = server/, а не с корня).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL,
  isProduction: process.env.NODE_ENV === "production",
};

export function requireDatabaseUrl(): string {
  return required("DATABASE_URL");
}

/** 32-байтный ключ (hex, 64 символа) для AES-256-GCM шифрования BingX-ключей в БД. */
export function requireEncryptionKey(): Buffer {
  const hex = required("ENCRYPTION_KEY");
  const buffer = Buffer.from(hex, "hex");
  if (buffer.length !== 32) {
    throw new Error("ENCRYPTION_KEY должен быть 32-байтным hex-значением (64 символа)");
  }
  return buffer;
}

/** Секрет для подписи сессионной куки (HMAC). Любая непустая строка, чем длиннее — тем лучше. */
export function requireSessionSecret(): string {
  return required("SESSION_SECRET");
}

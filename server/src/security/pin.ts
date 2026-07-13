import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

/** Хеширует PIN для хранения в settings (никогда не храним PIN в открытом виде). */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scryptAsync(pin, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

/** Сверяет введённый PIN с хешем; timing-safe сравнение против атак по времени. */
export async function verifyPin(pin: string, storedHash: string): Promise<boolean> {
  const [saltHex, keyHex] = storedHash.split(":");
  if (!saltHex || !keyHex) {
    return false;
  }
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");
  const derivedKey = (await scryptAsync(pin, salt, KEY_LENGTH)) as Buffer;
  if (derivedKey.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derivedKey, expected);
}

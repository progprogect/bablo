import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { requireEncryptionKey } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/** Шифрует строку (например, BingX secret key) перед сохранением в БД. */
export function encrypt(plainText: string): string {
  const key = requireEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(
    ".",
  );
}

/** Расшифровывает значение, сохранённое функцией encrypt(). */
export function decrypt(payload: string): string {
  const key = requireEncryptionKey();
  const [ivB64, authTagB64, ciphertextB64] = payload.split(".");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Некорректный формат зашифрованного значения");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plainText = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plainText.toString("utf8");
}

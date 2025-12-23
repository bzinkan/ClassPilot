import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ENCRYPTION_KEY_ENV = "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function getEncryptionKey(): Buffer {
  const rawKey = process.env[ENCRYPTION_KEY_ENV];
  if (!rawKey) {
    throw new Error(
      `Missing ${ENCRYPTION_KEY_ENV}. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }

  const base64Key = Buffer.from(rawKey, "base64");
  if (base64Key.length === KEY_BYTES) {
    return base64Key;
  }

  const rawKeyBuffer = Buffer.from(rawKey);
  if (rawKeyBuffer.length === KEY_BYTES) {
    return rawKeyBuffer;
  }

  throw new Error(`${ENCRYPTION_KEY_ENV} must be 32 bytes (base64 recommended).`);
}

export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string") {
    throw new Error("encryptSecret expects a string plaintext.");
  }

  const iv = randomBytes(IV_BYTES);
  const key = getEncryptionKey();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptSecret(ciphertext: string): string {
  if (typeof ciphertext !== "string") {
    throw new Error("decryptSecret expects a string ciphertext.");
  }

  const [ivPart, tagPart, dataPart] = ciphertext.split(".");
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error("Invalid encrypted secret format.");
  }

  const iv = Buffer.from(ivPart, "base64");
  const tag = Buffer.from(tagPart, "base64");
  const data = Buffer.from(dataPart, "base64");

  if (iv.length !== IV_BYTES) {
    throw new Error("Invalid encrypted secret IV length.");
  }

  const key = getEncryptionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

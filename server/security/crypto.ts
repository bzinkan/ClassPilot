import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { isProduction } from "../util/env";

const ENCRYPTION_KEY_ENV = "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const DEV_WARNING =
  "[crypto] Using ephemeral dev encryption key; tokens will not decrypt across restarts.";
const GENERATE_KEY_MESSAGE =
  `Generate a 32-byte key with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`;

let cachedKey: Buffer | null = null;
let warnedEphemeralKey = false;

function warnEphemeralKey() {
  if (!warnedEphemeralKey) {
    console.warn(DEV_WARNING);
    warnedEphemeralKey = true;
  }
}

function parseEncryptionKey(rawKey: string): Buffer | null {
  const trimmedKey = rawKey.trim();
  if (!trimmedKey) {
    return null;
  }

  const base64Key = Buffer.from(trimmedKey, "base64");
  if (base64Key.length === KEY_BYTES) {
    return base64Key;
  }

  const rawKeyBuffer = Buffer.from(trimmedKey);
  if (rawKeyBuffer.length === KEY_BYTES) {
    return rawKeyBuffer;
  }

  return null;
}

function getEncryptionKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }

  const rawKey = process.env[ENCRYPTION_KEY_ENV];

  if (rawKey) {
    const parsedKey = parseEncryptionKey(rawKey);
    if (parsedKey) {
      cachedKey = parsedKey;
      return parsedKey;
    }

    if (isProduction()) {
      throw new Error(
        `${ENCRYPTION_KEY_ENV} must be 32 bytes. ${GENERATE_KEY_MESSAGE}`
      );
    }

    warnEphemeralKey();
    cachedKey = randomBytes(KEY_BYTES);
    return cachedKey;
  }

  if (isProduction()) {
    throw new Error(`Missing ${ENCRYPTION_KEY_ENV}. ${GENERATE_KEY_MESSAGE}`);
  }

  warnEphemeralKey();
  cachedKey = randomBytes(KEY_BYTES);
  return cachedKey;
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

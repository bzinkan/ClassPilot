import crypto from "crypto";

/**
 * Generates a cryptographically secure random password
 * @param length - Length of the password in bytes (default: 16 for 128-bit entropy)
 * @returns Base64-encoded random password
 */
export function generateSecurePassword(length: number = 16): string {
  return crypto.randomBytes(length).toString("base64");
}

/**
 * Generates a user-friendly secure password with letters, numbers, and symbols
 * @param length - Length of the password (default: 16)
 * @returns Alphanumeric password with symbols
 */
export function generateFriendlySecurePassword(length: number = 16): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  const randomBytes = crypto.randomBytes(length);
  let password = "";

  for (let i = 0; i < length; i++) {
    password += chars[randomBytes[i] % chars.length];
  }

  return password;
}

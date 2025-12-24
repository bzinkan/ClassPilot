import { randomBytes } from "crypto";

const DEFAULT_SECRET_MIN_BYTES = 32;

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function getRequiredSecret(
  name: string,
  options?: {
    minBytes?: number;
    devLogMessage?: string;
  }
): string {
  const minBytes = options?.minBytes ?? DEFAULT_SECRET_MIN_BYTES;
  const value = process.env[name]?.trim();

  if (isProduction()) {
    if (!value) {
      throw new Error(`${name} is required in production.`);
    }
    if (Buffer.byteLength(value) < minBytes) {
      throw new Error(`${name} must be at least ${minBytes} bytes.`);
    }
    return value;
  }

  if (value && Buffer.byteLength(value) >= minBytes) {
    return value;
  }

  const generated = randomBytes(minBytes).toString("base64");
  if (options?.devLogMessage) {
    console.log(options.devLogMessage);
  }
  return generated;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`[CONFIG] Missing required env var: ${name}`);
  }
  return value;
}

export function requireEnvInProduction(name: string): string | undefined {
  if (process.env.NODE_ENV === "production") {
    return requireEnv(name);
  }
  return process.env[name];
}

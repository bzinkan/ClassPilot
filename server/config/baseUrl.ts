const DEFAULT_BASE_URL = "http://localhost:5000";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getBaseUrl(): string {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim();
  if (publicBaseUrl) {
    return stripTrailingSlash(publicBaseUrl);
  }

  if (process.env.REPLIT_DEV_DOMAIN) {
    return stripTrailingSlash(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  }

  return DEFAULT_BASE_URL;
}

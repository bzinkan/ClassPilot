import type { Request } from "express";
import { getBaseUrl } from "./baseUrl";

function getHostBaseUrl(req?: Request): string | undefined {
  const host = req?.headers.host;
  if (!host) {
    return undefined;
  }
  // Use the protocol from x-forwarded-proto header (set by load balancer) or default to http
  const proto = req?.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`;
}

export function buildClientConfig(req?: Request) {
  const baseUrl = process.env.PUBLIC_BASE_URL?.trim() || getHostBaseUrl(req) || getBaseUrl();
  return {
    baseUrl,
    schoolId: process.env.SCHOOL_ID || "default-school",
    wsAvailable: Boolean(process.env.WS_SHARED_KEY),
  };
}

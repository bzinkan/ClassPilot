import type { RequestHandler } from "express";

type RollingCounter = {
  windowStart: number;
  count: number;
};

const WINDOW_MS = 60_000;

export const DEVICE_MAX_PER_MIN = 12;
export const SCHOOL_MAX_PER_MIN = 3000;

const counters = new Map<string, RollingCounter>();

function isRateLimited(key: string, max: number, now: number): boolean {
  const existing = counters.get(key);
  if (!existing || now - existing.windowStart >= WINDOW_MS) {
    counters.set(key, { windowStart: now, count: 1 });
    return false;
  }

  existing.count += 1;
  if (existing.count > max) {
    return true;
  }

  return false;
}

export const deviceRateLimit: RequestHandler = (_req, res, next) => {
  const schoolId = res.locals.schoolId as string | undefined;
  const deviceId = res.locals.deviceId as string | undefined;

  if (!schoolId || !deviceId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const now = Date.now();
  const schoolKey = `school:${schoolId}`;
  const deviceKey = `device:${deviceId}`;

  if (isRateLimited(deviceKey, DEVICE_MAX_PER_MIN, now) || isRateLimited(schoolKey, SCHOOL_MAX_PER_MIN, now)) {
    return res.status(429).json({ error: "rate_limited" });
  }

  return next();
};

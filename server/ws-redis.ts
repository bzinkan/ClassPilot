import { randomUUID } from "crypto";
import { createClient, type RedisClientType } from "redis";
import { getOptionalEnv } from "./util/env";

export type WsRedisTarget =
  | { kind: "staff"; schoolId: string }
  | { kind: "students"; schoolId: string; targetDeviceIds?: string[] }
  | { kind: "device"; schoolId: string; deviceId: string }
  | { kind: "role"; schoolId: string; role: "teacher" | "school_admin" | "super_admin" | "student" };

type WsRedisEnvelope = {
  instanceId: string;
  target: WsRedisTarget;
  message: unknown;
};

const instanceId = randomUUID();
const redisUrl = getOptionalEnv("REDIS_URL");
const redisPrefix = getOptionalEnv("REDIS_PREFIX") ?? "classpilot";
const redisChannel = `${redisPrefix}:ws:broadcast`;

let redisPublisher: RedisClientType | null = null;
let redisSubscriber: RedisClientType | null = null;
let redisEnabled = false;
let redisWarned = false;
let redisInitPromise: Promise<void> | null = null;
let subscribed = false;

function warnRedis(error?: unknown) {
  if (redisWarned) {
    return;
  }
  redisWarned = true;
  if (error) {
    console.warn("[WebSocket] Redis pub/sub disabled; running single-instance mode.", error);
    return;
  }
  console.warn("[WebSocket] Redis pub/sub disabled; running single-instance mode.");
}

async function ensureRedisReady(): Promise<void> {
  if (!redisUrl) {
    return;
  }
  if (redisInitPromise) {
    return redisInitPromise;
  }

  redisInitPromise = (async () => {
    try {
      redisPublisher = createClient({ url: redisUrl });
      redisPublisher.on("error", warnRedis);
      await redisPublisher.connect();

      redisSubscriber = redisPublisher.duplicate();
      redisSubscriber.on("error", warnRedis);
      await redisSubscriber.connect();

      redisEnabled = true;
    } catch (error) {
      redisEnabled = false;
      warnRedis(error);
    }
  })();

  return redisInitPromise;
}

export function isRedisEnabled(): boolean {
  return redisEnabled;
}

export async function subscribeWS(
  onMessage: (target: WsRedisTarget, message: unknown) => void
): Promise<void> {
  if (!redisUrl) {
    return;
  }
  await ensureRedisReady();
  if (!redisEnabled || !redisSubscriber || subscribed) {
    return;
  }

  subscribed = true;
  try {
    await redisSubscriber.subscribe(redisChannel, (payload: string) => {
      try {
        const message = JSON.parse(payload) as WsRedisEnvelope;
        if (!message || message.instanceId === instanceId) {
          return;
        }
        onMessage(message.target, message.message);
      } catch (error) {
        warnRedis(error);
      }
    });
  } catch (error) {
    warnRedis(error);
  }
}

export async function publishWS(target: WsRedisTarget, message: unknown): Promise<void> {
  if (!redisUrl) {
    return;
  }
  await ensureRedisReady();
  if (!redisEnabled || !redisPublisher) {
    return;
  }

  const payload: WsRedisEnvelope = {
    instanceId,
    target,
    message,
  };

  try {
    await redisPublisher.publish(redisChannel, JSON.stringify(payload));
  } catch (error) {
    warnRedis(error);
  }
}

// Screenshot storage in Redis (for multi-instance deployments)
const SCREENSHOT_KEY_PREFIX = `${redisPrefix}:screenshot:`;
const SCREENSHOT_TTL_SECONDS = 60; // 60 seconds TTL

export type ScreenshotData = {
  screenshot: string;
  timestamp: number;
  tabTitle?: string;
  tabUrl?: string;
  tabFavicon?: string;
};

export async function setScreenshot(deviceId: string, data: ScreenshotData): Promise<boolean> {
  if (!redisUrl) {
    return false; // Fallback to in-memory
  }
  await ensureRedisReady();
  if (!redisEnabled || !redisPublisher) {
    return false;
  }

  try {
    const key = `${SCREENSHOT_KEY_PREFIX}${deviceId}`;
    await redisPublisher.setEx(key, SCREENSHOT_TTL_SECONDS, JSON.stringify(data));
    return true;
  } catch (error) {
    console.warn("[Screenshot] Redis setEx failed:", error);
    return false;
  }
}

export async function getScreenshot(deviceId: string): Promise<ScreenshotData | null> {
  if (!redisUrl) {
    return null; // Fallback to in-memory
  }
  await ensureRedisReady();
  if (!redisEnabled || !redisPublisher) {
    return null;
  }

  try {
    const key = `${SCREENSHOT_KEY_PREFIX}${deviceId}`;
    const data = await redisPublisher.get(key);
    if (!data) {
      return null;
    }
    return JSON.parse(data) as ScreenshotData;
  } catch (error) {
    console.warn("[Screenshot] Redis get failed:", error);
    return null;
  }
}

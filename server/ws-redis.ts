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
const instanceShortId = instanceId.slice(0, 8); // Short ID for logging
const redisUrl = getOptionalEnv("REDIS_URL");
const redisPrefix = getOptionalEnv("REDIS_PREFIX") ?? "classpilot";
const redisChannel = `${redisPrefix}:ws:broadcast`;

console.log(`[Redis] Instance ${instanceShortId} starting, Redis URL: ${redisUrl ? 'configured' : 'NOT configured'}`);

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
      console.log(`[Redis] Instance ${instanceShortId} connecting to Redis...`);
      redisPublisher = createClient({ url: redisUrl });
      redisPublisher.on("error", (err: unknown) => {
        console.error(`[Redis] Instance ${instanceShortId} publisher error:`, err);
        warnRedis(err);
      });
      await redisPublisher.connect();
      console.log(`[Redis] Instance ${instanceShortId} publisher connected`);

      redisSubscriber = redisPublisher.duplicate();
      redisSubscriber.on("error", (err: unknown) => {
        console.error(`[Redis] Instance ${instanceShortId} subscriber error:`, err);
        warnRedis(err);
      });
      await redisSubscriber.connect();
      console.log(`[Redis] Instance ${instanceShortId} subscriber connected`);

      redisEnabled = true;
      console.log(`[Redis] Instance ${instanceShortId} fully initialized`);
    } catch (error) {
      redisEnabled = false;
      console.error(`[Redis] Instance ${instanceShortId} initialization failed:`, error);
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
  console.log(`[Redis] Instance ${instanceShortId} subscribing to channel: ${redisChannel}`);
  try {
    await redisSubscriber.subscribe(redisChannel, (payload: string) => {
      try {
        const envelope = JSON.parse(payload) as WsRedisEnvelope;
        if (!envelope) {
          return;
        }
        const senderShortId = envelope.instanceId.slice(0, 8);
        // Skip messages from this instance (they were already handled locally)
        if (envelope.instanceId === instanceId) {
          return;
        }
        const msgType = (envelope.message as { type?: string })?.type ?? 'unknown';
        console.log(`[Redis] Instance ${instanceShortId} received ${msgType} from ${senderShortId}, target: ${envelope.target.kind}`);
        onMessage(envelope.target, envelope.message);
      } catch (error) {
        console.error(`[Redis] Instance ${instanceShortId} message parse error:`, error);
        warnRedis(error);
      }
    });
    console.log(`[Redis] Instance ${instanceShortId} successfully subscribed to ${redisChannel}`);
  } catch (error) {
    console.error(`[Redis] Instance ${instanceShortId} subscription failed:`, error);
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
    const msgType = (message as { type?: string })?.type ?? 'unknown';
    const targetInfo = target.kind === 'device' ? `device:${(target as any).deviceId}` : target.kind;
    console.log(`[Redis] Instance ${instanceShortId} publishing ${msgType} to ${targetInfo}`);
    const numSubscribers = await redisPublisher.publish(redisChannel, JSON.stringify(payload));
    console.log(`[Redis] Instance ${instanceShortId} published ${msgType}, ${numSubscribers} subscribers received`);
  } catch (error) {
    console.error(`[Redis] Instance ${instanceShortId} publish failed:`, error);
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

// Flight path status storage in Redis (for multi-instance deployments)
const FLIGHT_PATH_KEY_PREFIX = `${redisPrefix}:flightpath:`;
const FLIGHT_PATH_TTL_SECONDS = 3600; // 1 hour TTL (flight paths persist for the session)

export type FlightPathStatus = {
  active: boolean;
  flightPathName?: string;
  flightPathId?: string;
  appliedAt: number;
};

export async function setFlightPathStatus(deviceId: string, data: FlightPathStatus): Promise<boolean> {
  if (!redisUrl) {
    return false; // Fallback to in-memory
  }
  await ensureRedisReady();
  if (!redisEnabled || !redisPublisher) {
    return false;
  }

  try {
    const key = `${FLIGHT_PATH_KEY_PREFIX}${deviceId}`;
    if (data.active) {
      await redisPublisher.setEx(key, FLIGHT_PATH_TTL_SECONDS, JSON.stringify(data));
    } else {
      // When removing flight path, delete the key
      await redisPublisher.del(key);
    }
    return true;
  } catch (error) {
    console.warn("[FlightPath] Redis set failed:", error);
    return false;
  }
}

export async function getFlightPathStatus(deviceId: string): Promise<FlightPathStatus | null> {
  if (!redisUrl) {
    return null; // Fallback to in-memory
  }
  await ensureRedisReady();
  if (!redisEnabled || !redisPublisher) {
    return null;
  }

  try {
    const key = `${FLIGHT_PATH_KEY_PREFIX}${deviceId}`;
    const data = await redisPublisher.get(key);
    if (!data) {
      return null;
    }
    return JSON.parse(data) as FlightPathStatus;
  } catch (error) {
    console.warn("[FlightPath] Redis get failed:", error);
    return null;
  }
}

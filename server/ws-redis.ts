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
  console.log(`[WS-Redis] Subscribed to channel ${redisChannel} (instance: ${instanceId.slice(0, 8)})`);
  try {
    await redisSubscriber.subscribe(redisChannel, (payload: string) => {
      try {
        const envelope = JSON.parse(payload) as WsRedisEnvelope;
        if (!envelope || envelope.instanceId === instanceId) {
          return; // Ignore own messages
        }
        console.log(`[WS-Redis] Received message from instance ${envelope.instanceId.slice(0, 8)}, target: ${JSON.stringify(envelope.target)}`);
        onMessage(envelope.target, envelope.message);
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
    console.log(`[WS-Redis] Published to ${target.kind}: ${JSON.stringify(target)}`);
  } catch (error) {
    warnRedis(error);
  }
}

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createTestStorage } from "./testUtils";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("production session configuration", () => {
  it("enables trust proxy and secure cookies", async () => {
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "test-secret-".repeat(4);
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

    const { app, server } = await createApp({
      storage: createTestStorage(),
      enableBackgroundJobs: false,
    });

    expect(app.get("trust proxy")).toBe(1);

    const cookieOptions = app.get("session-cookie-options");
    expect(cookieOptions?.secure).toBe(true);

    server.close();
  });
});

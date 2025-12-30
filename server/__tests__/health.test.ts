import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp } from "./testUtils";

describe("health endpoint", () => {
  let app: ReturnType<typeof request>;
  let server: Awaited<ReturnType<typeof createTestApp>>["server"];

  beforeAll(async () => {
    const created = await createTestApp();
    app = request(created.app);
    server = created.server;
  });

  afterAll(() => {
    server.close();
  });

  it("returns ok payload", async () => {
    const response = await app.get("/health");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.database).toBeDefined();
    expect(response.body.timestamp).toBeDefined();
  });
});

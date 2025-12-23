import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp } from "./testUtils";

describe("auth session boot", () => {
  let server: Awaited<ReturnType<typeof createTestApp>>["server"];
  let agent: request.SuperAgentTest;
  let storage: Awaited<ReturnType<typeof createTestApp>>["storage"];

  beforeAll(async () => {
    const created = await createTestApp();
    server = created.server;
    storage = created.storage;
    await storage.seedUser({ password: "testpass123" });
    agent = request.agent(created.app);
  });

  afterAll(() => {
    server.close();
  });

  it("boots a session after login and returns /api/me", async () => {
    const loginResponse = await agent.post("/api/login").send({
      email: "teacher@classpilot.test",
      password: "testpass123",
    });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body).toMatchObject({ success: true });

    const meResponse = await agent.get("/api/me");
    expect(meResponse.status).toBe(200);
    expect(meResponse.body).toMatchObject({
      user: {
        email: "teacher@classpilot.test",
        role: "teacher",
      },
    });
  });
});

import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp } from "./testUtils";

describe("tenant isolation guards", () => {
  let server: Awaited<ReturnType<typeof createTestApp>>["server"];
  let agent: request.SuperAgentTest;
  let storage: Awaited<ReturnType<typeof createTestApp>>["storage"];

  beforeAll(async () => {
    const created = await createTestApp();
    server = created.server;
    storage = created.storage;
    await storage.seedUser({ password: "testpass123", schoolId: "school-1", role: "teacher" });
    await storage.seedStudent({ id: "student-2", schoolId: "school-2" });
    await storage.seedDevice({ deviceId: "device-2", schoolId: "school-2" });
    agent = request.agent(created.app);

    await agent.post("/api/login").send({
      email: "teacher@classpilot.test",
      password: "testpass123",
    });
  });

  afterAll(() => {
    server.close();
  });

  it("blocks cross-school student updates", async () => {
    const response = await agent.patch("/api/students/student-2").send({
      studentName: "Nope",
    });

    expect(response.status).toBe(403);
  });

  it("blocks cross-school device updates", async () => {
    const response = await agent.patch("/api/devices/device-2").send({
      deviceName: "Nope",
    });

    expect(response.status).toBe(403);
  });
});

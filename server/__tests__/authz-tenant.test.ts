import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp } from "./testUtils";

describe("tenant isolation guards", () => {
  let server: Awaited<ReturnType<typeof createTestApp>>["server"];
  let app: Awaited<ReturnType<typeof createTestApp>>["app"];
  let agent: request.SuperAgentTest;
  let storage: Awaited<ReturnType<typeof createTestApp>>["storage"];

  beforeAll(async () => {
    const created = await createTestApp();
    server = created.server;
    app = created.app;
    storage = created.storage;
    await storage.seedSchool({ id: "school-1", domain: "classpilot.test" });
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

  it("blocks inactive schools and invalidates session", async () => {
    await storage.updateSchool("school-1", { isActive: false, planStatus: "canceled" });

    const response = await agent.get("/api/students");

    expect(response.status).toBe(402);
    expect(response.body).toMatchObject({ error: "School license inactive" });

    const followUp = await agent.get("/api/me");
    expect(followUp.status).toBe(401);

    await storage.updateSchool("school-1", { isActive: true, planStatus: "active" });
  });

  it("rejects sessions when schoolSessionVersion mismatches", async () => {
    await storage.updateSchool("school-1", { isActive: true, planStatus: "active" });
    const freshAgent = request.agent(app);

    await freshAgent.post("/api/login").send({
      email: "teacher@classpilot.test",
      password: "testpass123",
    });

    await storage.bumpSchoolSessionVersion("school-1");

    const response = await freshAgent.get("/api/students");

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: "Session invalidated" });
  });

  it("reports inactive status via school status endpoint", async () => {
    await storage.seedSchool({
      id: "school-2",
      domain: "inactive.test",
      isActive: false,
      planStatus: "canceled",
    });

    const response = await request(server)
      .post("/api/school/status")
      .send({ studentEmail: "student@inactive.test" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      schoolId: "school-2",
      schoolActive: false,
      planStatus: "canceled",
    });
  });
});

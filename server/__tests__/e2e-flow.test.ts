import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp } from "./testUtils";

describe("e2e session flow", () => {
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

  it("logs in, fetches csrf, and starts/ends a session", async () => {
    const loginResponse = await agent.post("/api/login").send({
      email: "teacher@classpilot.test",
      password: "testpass123",
    });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body).toMatchObject({ success: true });

    const csrfResponse = await agent.get("/api/csrf");
    expect(csrfResponse.status).toBe(200);
    expect(typeof csrfResponse.body.csrfToken).toBe("string");

    const csrfToken = csrfResponse.body.csrfToken as string;

    const groupResponse = await agent
      .post("/api/teacher/groups")
      .set("X-CSRF-Token", csrfToken)
      .send({ name: "Test Group" });

    expect(groupResponse.status).toBe(200);
    expect(groupResponse.body.id).toBeTruthy();

    const groupId = groupResponse.body.id as string;

    const startResponse = await agent
      .post("/api/sessions/start")
      .set("X-CSRF-Token", csrfToken)
      .send({ groupId });

    expect(startResponse.status).toBe(200);
    expect(startResponse.body.groupId).toBe(groupId);

    const activeResponse = await agent.get("/api/sessions/active");
    expect(activeResponse.status).toBe(200);
    expect(activeResponse.body?.groupId).toBe(groupId);

    const endResponse = await agent
      .post("/api/sessions/end")
      .set("X-CSRF-Token", csrfToken)
      .send();

    expect(endResponse.status).toBe(200);
    expect(endResponse.body.endTime).toBeTruthy();

    const inactiveResponse = await agent.get("/api/sessions/active");
    expect(inactiveResponse.status).toBe(200);
    expect(inactiveResponse.body).toBeNull();
  });
});

import bcrypt from "bcrypt";
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp } from "./testUtils";

describe("account password", () => {
  let server: Awaited<ReturnType<typeof createTestApp>>["server"];
  let app: Awaited<ReturnType<typeof createTestApp>>["app"];
  let storage: Awaited<ReturnType<typeof createTestApp>>["storage"];

  beforeAll(async () => {
    const created = await createTestApp();
    server = created.server;
    app = created.app;
    storage = created.storage;

    await storage.seedUser({
      id: "user-with-pass",
      email: "user1@classpilot.test",
      username: "user1",
      password: "currentpass123",
      role: "teacher",
      schoolId: "school-1",
    });

    await storage.seedUser({
      id: "user-no-pass",
      email: "user2@classpilot.test",
      username: "user2",
      password: "tempPass123",
      role: "teacher",
      schoolId: "school-1",
    });
  });

  afterAll(() => {
    server.close();
  });

  it("returns 401 for unauthenticated requests", async () => {
    const securityResponse = await request(app).get("/api/account/security");
    expect(securityResponse.status).toBe(401);

    const passwordResponse = await request(app)
      .post("/api/account/password")
      .send({ newPassword: "newpassword123" });
    expect(passwordResponse.status).toBe(401);
  });

  it("rejects incorrect current password", async () => {
    const agent = request.agent(app);
    await agent.post("/api/login").send({
      email: "user1@classpilot.test",
      password: "currentpass123",
    });

    const csrfResponse = await agent.get("/api/csrf");
    const csrfToken = csrfResponse.body.csrfToken;

    const response = await agent
      .post("/api/account/password")
      .set("X-CSRF-Token", csrfToken)
      .send({ currentPassword: "wrongpassword", newPassword: "newpassword123" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Current password is incorrect." });
  });

  it("updates password when current password is correct", async () => {
    const agent = request.agent(app);
    await agent.post("/api/login").send({
      email: "user1@classpilot.test",
      password: "currentpass123",
    });

    const csrfResponse = await agent.get("/api/csrf");
    const csrfToken = csrfResponse.body.csrfToken;

    const previous = await storage.getUser("user-with-pass");
    const response = await agent
      .post("/api/account/password")
      .set("X-CSRF-Token", csrfToken)
      .send({ currentPassword: "currentpass123", newPassword: "newpassword456" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    const updated = await storage.getUser("user-with-pass");
    expect(updated?.password).toBeTruthy();
    expect(updated?.password).not.toEqual(previous?.password);

    const matches = await bcrypt.compare("newpassword456", updated?.password ?? "");
    expect(matches).toBe(true);
  });

  it("allows setting a new password when no password exists", async () => {
    const agent = request.agent(app);
    await agent.post("/api/login").send({
      email: "user2@classpilot.test",
      password: "tempPass123",
    });

    await storage.updateUser("user-no-pass", { password: null });

    const csrfResponse = await agent.get("/api/csrf");
    const csrfToken = csrfResponse.body.csrfToken;

    const response = await agent
      .post("/api/account/password")
      .set("X-CSRF-Token", csrfToken)
      .send({ newPassword: "freshpassword123" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    const updated = await storage.getUser("user-no-pass");
    expect(updated?.password).toBeTruthy();

    const matches = await bcrypt.compare("freshpassword123", updated?.password ?? "");
    expect(matches).toBe(true);
  });
});

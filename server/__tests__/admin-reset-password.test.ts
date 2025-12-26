import bcrypt from "bcrypt";
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp } from "./testUtils";

describe("admin reset teacher password", () => {
  let server: Awaited<ReturnType<typeof createTestApp>>["server"];
  let app: Awaited<ReturnType<typeof createTestApp>>["app"];
  let storage: Awaited<ReturnType<typeof createTestApp>>["storage"];
  let agent: request.SuperAgentTest;
  let csrfToken: string;

  beforeAll(async () => {
    const created = await createTestApp();
    server = created.server;
    app = created.app;
    storage = created.storage;

    await storage.seedSchool({ id: "school-1", domain: "classpilot.test" });
    await storage.seedSchool({ id: "school-2", domain: "other.test" });

    await storage.seedUser({
      id: "admin-1",
      email: "admin@classpilot.test",
      username: "admin",
      password: "adminpass123",
      role: "school_admin",
      schoolId: "school-1",
    });

    await storage.seedUser({
      id: "teacher-1",
      email: "teacher1@classpilot.test",
      username: "teacher1",
      password: "teacherpass123",
      role: "teacher",
      schoolId: "school-1",
    });

    await storage.seedUser({
      id: "teacher-2",
      email: "teacher2@other.test",
      username: "teacher2",
      password: "teacherpass456",
      role: "teacher",
      schoolId: "school-2",
    });

    agent = request.agent(app);
    await agent.post("/api/login").send({
      email: "admin@classpilot.test",
      password: "adminpass123",
    });

    const csrfResponse = await agent.get("/api/csrf");
    csrfToken = csrfResponse.body.csrfToken;
  });

  afterAll(() => {
    server.close();
  });

  it("allows school admins to reset passwords for teachers in the same school", async () => {
    const response = await agent
      .post("/api/admin/users/teacher-1/password")
      .set("X-CSRF-Token", csrfToken)
      .send({ newPassword: "newpassword123" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    const updated = await storage.getUser("teacher-1");
    expect(updated?.password).toBeTruthy();
    const matches = await bcrypt.compare("newpassword123", updated?.password ?? "");
    expect(matches).toBe(true);
  });

  it("blocks school admins from resetting passwords in other schools", async () => {
    const response = await agent
      .post("/api/admin/users/teacher-2/password")
      .set("X-CSRF-Token", csrfToken)
      .send({ newPassword: "anotherpass123" });

    expect(response.status).toBe(403);
  });

  it("blocks teachers from resetting passwords", async () => {
    const teacherAgent = request.agent(app);
    await teacherAgent.post("/api/login").send({
      email: "teacher1@classpilot.test",
      password: "teacherpass123",
    });

    const csrfResponse = await teacherAgent.get("/api/csrf");
    const teacherCsrf = csrfResponse.body.csrfToken;

    const response = await teacherAgent
      .post("/api/admin/users/teacher-1/password")
      .set("X-CSRF-Token", teacherCsrf)
      .send({ newPassword: "teacherreset123" });

    expect(response.status).toBe(403);
  });
});

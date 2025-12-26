import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp } from "./testUtils";

describe("admin user management", () => {
  let server: Awaited<ReturnType<typeof createTestApp>>["server"];
  let app: Awaited<ReturnType<typeof createTestApp>>["app"];
  let storage: Awaited<ReturnType<typeof createTestApp>>["storage"];
  let agent: request.SuperAgentTest;
  let csrfToken: string;

  beforeEach(async () => {
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
      email: "teacher@classpilot.test",
      username: "teacher",
      password: "teacherpass123",
      role: "teacher",
      schoolId: "school-1",
    });

    await storage.seedUser({
      id: "teacher-2",
      email: "teacher@other.test",
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

  afterEach(() => {
    server.close();
  });

  it("allows school admins to create another school admin in the same school", async () => {
    const response = await agent
      .post("/api/admin/users")
      .set("X-CSRF-Token", csrfToken)
      .send({
        email: "admin2@classpilot.test",
        role: "school_admin",
        name: "Admin Two",
        password: "newpass123",
      });

    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe("school_admin");

    const created = await storage.getUserByEmail("admin2@classpilot.test");
    expect(created?.schoolId).toBe("school-1");
  });

  it("forces new users into the admin's school", async () => {
    const response = await agent
      .post("/api/admin/users")
      .set("X-CSRF-Token", csrfToken)
      .send({
        email: "teacher2@classpilot.test",
        role: "teacher",
        name: "Teacher Two",
        schoolId: "school-2",
      });

    expect(response.status).toBe(200);
    const created = await storage.getUserByEmail("teacher2@classpilot.test");
    expect(created?.schoolId).toBe("school-1");
  });

  it("allows school admins to promote a teacher to school admin", async () => {
    const response = await agent
      .patch("/api/admin/users/teacher-1")
      .set("X-CSRF-Token", csrfToken)
      .send({ role: "school_admin" });

    expect(response.status).toBe(200);
    const updated = await storage.getUser("teacher-1");
    expect(updated?.role).toBe("school_admin");
  });

  it("blocks demoting the last remaining school admin", async () => {
    const response = await agent
      .patch("/api/admin/users/admin-1")
      .set("X-CSRF-Token", csrfToken)
      .send({ role: "teacher" });

    expect(response.status).toBe(400);
  });

  it("blocks deleting the last remaining school admin", async () => {
    const response = await agent
      .delete("/api/admin/users/admin-1")
      .set("X-CSRF-Token", csrfToken);

    expect(response.status).toBe(400);
  });

  it("blocks teachers from accessing staff management", async () => {
    const teacherAgent = request.agent(app);
    await teacherAgent.post("/api/login").send({
      email: "teacher@classpilot.test",
      password: "teacherpass123",
    });

    const response = await teacherAgent.get("/api/admin/users");
    expect(response.status).toBe(403);
  });

  it("blocks cross-school management", async () => {
    const response = await agent
      .patch("/api/admin/users/teacher-2")
      .set("X-CSRF-Token", csrfToken)
      .send({ role: "school_admin" });

    expect(response.status).toBe(403);
  });
});

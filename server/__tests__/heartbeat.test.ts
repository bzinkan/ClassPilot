import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createStudentToken } from "../jwt-utils";
import { createTestApp } from "./testUtils";

describe("heartbeat endpoint", () => {
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

  it("accepts a valid heartbeat payload", async () => {
    const studentToken = createStudentToken({
      studentId: "student-1",
      deviceId: "device-1",
      schoolId: "school-1",
    });

    const response = await app.post("/api/heartbeat").send({
      deviceId: "device-1",
      studentId: "student-1",
      schoolId: "school-1",
      activeTabTitle: "Unit Test",
      activeTabUrl: "https://example.com",
      isSharing: false,
      screenLocked: false,
      flightPathActive: false,
      cameraActive: false,
      studentToken,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true });
  });
});

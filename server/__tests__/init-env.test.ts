import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
  vi.clearAllMocks();
});

describe("initializeApp env validation", () => {
  it("throws in production when WS_SHARED_KEY is missing", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.WS_SHARED_KEY;

    vi.doMock("../storage", () => ({
      storage: {
        getUserByEmail: vi.fn().mockResolvedValue(null),
        getUserByUsername: vi.fn().mockResolvedValue(null),
        getSettingsBySchoolId: vi.fn().mockResolvedValue(null),
        upsertSettingsForSchool: vi.fn().mockResolvedValue(null),
        getStudentsBySchool: vi.fn().mockResolvedValue([]),
        getUsersBySchool: vi.fn().mockResolvedValue([]),
        getTeacherStudents: vi.fn().mockResolvedValue([]),
        assignStudentToTeacher: vi.fn().mockResolvedValue(undefined),
        getFlightPathsBySchool: vi.fn().mockResolvedValue([]),
        updateFlightPath: vi.fn().mockResolvedValue(undefined),
        getStudentGroupsBySchool: vi.fn().mockResolvedValue([]),
        updateStudentGroup: vi.fn().mockResolvedValue(undefined),
      },
    }));

    const { initializeApp } = await import("../init");

    await expect(initializeApp()).rejects.toThrow(/WS_SHARED_KEY/);
  });
});

import bcrypt from "bcrypt";
import type { Express } from "express";
import { createApp } from "../app";
import type { IStorage } from "../storage";

export async function createTestApp() {
  const storage = createTestStorage();
  const { app, server } = await createApp({
    storage,
    enableBackgroundJobs: false,
  });
  return { app, server, storage };
}

export function createTestStorage() {
  const users = new Map<string, any>();
  const students = new Map<string, any>();
  const devices = new Map<string, any>();
  const schools = new Map<string, any>();

  return {
    users,
    students,
    devices,
    async seedUser(overrides?: Partial<any>) {
      const password = await bcrypt.hash(overrides?.password ?? "password123", 10);
      const user = {
        id: overrides?.id ?? "user-1",
        email: overrides?.email ?? "teacher@classpilot.test",
        username: overrides?.username ?? "teacher",
        password,
        role: overrides?.role ?? "teacher",
        schoolId: overrides?.schoolId ?? "school-1",
        displayName: overrides?.displayName ?? "Test Teacher",
      };
      users.set(user.id, user);
      if (user.schoolId && !schools.has(user.schoolId)) {
        schools.set(user.schoolId, {
          id: user.schoolId,
          name: overrides?.schoolName ?? "Test School",
          domain: overrides?.schoolDomain ?? "classpilot.test",
          status: "active",
          isActive: true,
          planStatus: "active",
          stripeSubscriptionId: null,
          disabledAt: null,
          disabledReason: null,
          schoolSessionVersion: 1,
          maxLicenses: 100,
          createdAt: new Date(),
          trialEndsAt: null,
          deletedAt: null,
          lastActivityAt: null,
        });
      }
      return user;
    },
    async seedSchool(overrides?: Partial<any>) {
      const school = {
        id: overrides?.id ?? `school-${schools.size + 1}`,
        name: overrides?.name ?? "Test School",
        domain: overrides?.domain ?? `school${schools.size + 1}.test`,
        status: overrides?.status ?? "active",
        isActive: overrides?.isActive ?? true,
        planStatus: overrides?.planStatus ?? "active",
        stripeSubscriptionId: overrides?.stripeSubscriptionId ?? null,
        disabledAt: overrides?.disabledAt ?? null,
        disabledReason: overrides?.disabledReason ?? null,
        schoolSessionVersion: overrides?.schoolSessionVersion ?? 1,
        maxLicenses: overrides?.maxLicenses ?? 100,
        createdAt: overrides?.createdAt ?? new Date(),
        trialEndsAt: overrides?.trialEndsAt ?? null,
        deletedAt: overrides?.deletedAt ?? null,
        lastActivityAt: overrides?.lastActivityAt ?? null,
      };
      schools.set(school.id, school);
      return school;
    },
    async seedStudent(overrides?: Partial<any>) {
      const student = {
        id: overrides?.id ?? `student-${students.size + 1}`,
        deviceId: overrides?.deviceId ?? "device-1",
        studentName: overrides?.studentName ?? "Student",
        studentEmail: overrides?.studentEmail ?? "student@classpilot.test",
        gradeLevel: overrides?.gradeLevel ?? null,
        schoolId: overrides?.schoolId ?? "school-1",
        studentStatus: overrides?.studentStatus ?? "active",
      };
      students.set(student.id, student);
      return student;
    },
    async seedDevice(overrides?: Partial<any>) {
      const device = {
        deviceId: overrides?.deviceId ?? `device-${devices.size + 1}`,
        deviceName: overrides?.deviceName ?? "Device",
        classId: overrides?.classId ?? "class-1",
        schoolId: overrides?.schoolId ?? "school-1",
      };
      devices.set(device.deviceId, device);
      return device;
    },
    async getUser(id: string) {
      return users.get(id);
    },
    async getUserByEmail(email: string) {
      return Array.from(users.values()).find((user) => user.email === email);
    },
    async getUserByUsername(username: string) {
      return Array.from(users.values()).find((user) => user.username === username);
    },
    async getSettings() {
      return {
        enableTrackingHours: false,
        maxTabsPerStudent: null,
      };
    },
    async getSchool(id: string) {
      return schools.get(id);
    },
    async getSchoolByDomain(domain: string) {
      return Array.from(schools.values()).find((school) => school.domain === domain);
    },
    async updateSchool(id: string, updates: Partial<any>) {
      const school = schools.get(id);
      if (!school) {
        return undefined;
      }
      const updated = { ...school, ...updates };
      schools.set(id, updated);
      return updated;
    },
    async bumpSchoolSessionVersion(id: string) {
      const school = schools.get(id);
      if (!school) {
        return 0;
      }
      school.schoolSessionVersion = (school.schoolSessionVersion ?? 1) + 1;
      schools.set(id, school);
      return school.schoolSessionVersion;
    },
    async setSchoolActiveState(id: string, state: { isActive?: boolean; planStatus?: string; disabledReason?: string | null }) {
      const school = schools.get(id);
      if (!school) {
        return undefined;
      }
      const nextIsActive = state.isActive ?? school.isActive;
      const nextPlanStatus = state.planStatus ?? school.planStatus;
      const isDeactivating =
        (school.isActive && nextIsActive === false)
        || (school.planStatus !== "canceled" && nextPlanStatus === "canceled");
      const isReactivating =
        (!school.isActive && nextIsActive === true)
        || (school.planStatus === "canceled" && nextPlanStatus !== "canceled");

      school.isActive = nextIsActive;
      school.planStatus = nextPlanStatus;

      if (isDeactivating) {
        school.disabledAt = new Date();
        school.disabledReason = state.disabledReason ?? school.disabledReason ?? null;
        school.schoolSessionVersion = (school.schoolSessionVersion ?? 1) + 1;
      } else if (isReactivating) {
        school.disabledAt = null;
        school.disabledReason = null;
        school.schoolSessionVersion = (school.schoolSessionVersion ?? 1) + 1;
      } else if (state.disabledReason !== undefined) {
        school.disabledReason = state.disabledReason;
      }

      schools.set(id, school);
      return school;
    },
    async getStudent(id: string) {
      return students.get(id);
    },
    async updateStudent(id: string, updates: Partial<any>) {
      const student = students.get(id);
      if (!student) {
        return undefined;
      }
      const updated = { ...student, ...updates };
      students.set(id, updated);
      return updated;
    },
    async getDevice(deviceId: string) {
      return devices.get(deviceId);
    },
    async getDevicesBySchool(schoolId: string) {
      return Array.from(devices.values()).filter((device) => device.schoolId === schoolId);
    },
    async updateDevice(deviceId: string, updates: Partial<any>) {
      const device = devices.get(deviceId);
      if (!device) {
        return undefined;
      }
      const updated = { ...device, ...updates };
      devices.set(deviceId, updated);
      return updated;
    },
    async getStudentsBySchool(schoolId: string) {
      return Array.from(students.values()).filter((student) => student.schoolId === schoolId);
    },
    async getStudentsByDevice(schoolId: string, deviceId: string) {
      return Array.from(students.values()).filter(
        (student) => student.schoolId === schoolId && student.deviceId === deviceId
      );
    },
    async getStudentStatusesBySchool(_schoolId: string) {
      return [];
    },
    async getStudentStatusesAggregatedBySchool(_schoolId: string) {
      return [];
    },
    async addHeartbeat() {
      return { id: "hb-1" };
    },
    async getHeartbeatsBySchool(_schoolId: string) {
      return [];
    },
    async expireStaleStudentSessions() {
      return 0;
    },
    async getActiveSessions(_schoolId: string) {
      return [];
    },
    async getSessionsBySchool(_schoolId: string) {
      return [];
    },
    async getFlightPathsBySchool(_schoolId: string) {
      return [];
    },
    async getStudentGroupsBySchool(_schoolId: string) {
      return [];
    },
    async getRostersBySchool(_schoolId: string) {
      return [];
    },
    async cleanupOldHeartbeats() {
      return 0;
    },
  } as unknown as IStorage & { seedUser: (overrides?: Partial<any>) => Promise<any> };
}

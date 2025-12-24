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
      return user;
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
    async updateDevice(deviceId: string, updates: Partial<any>) {
      const device = devices.get(deviceId);
      if (!device) {
        return undefined;
      }
      const updated = { ...device, ...updates };
      devices.set(deviceId, updated);
      return updated;
    },
    async addHeartbeat() {
      return { id: "hb-1" };
    },
    async expireStaleStudentSessions() {
      return 0;
    },
    async cleanupOldHeartbeats() {
      return 0;
    },
  } as unknown as IStorage & { seedUser: (overrides?: Partial<any>) => Promise<any> };
}

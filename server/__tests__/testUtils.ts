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

  return {
    users,
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

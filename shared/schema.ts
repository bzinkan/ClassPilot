import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Teacher/Admin user
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  role: text("role").notNull().default("teacher"), // 'admin' or 'teacher'
  schoolName: text("school_name").notNull().default("School"),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Schema for creating teacher accounts (admin-only)
export const createTeacherSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  schoolName: z.string().optional(),
});
export type CreateTeacher = z.infer<typeof createTeacherSchema>;

// Device registration (Chromebooks)
export const devices = pgTable("devices", {
  deviceId: varchar("device_id").primaryKey(),
  deviceName: text("device_name"),
  schoolId: text("school_id").notNull(),
  classId: text("class_id").notNull(),
  registeredAt: timestamp("registered_at").notNull().default(sql`now()`),
});

export const insertDeviceSchema = createInsertSchema(devices).omit({ registeredAt: true });
export type InsertDevice = z.infer<typeof insertDeviceSchema>;
export type Device = typeof devices.$inferSelect;

// Students assigned to devices (multiple students can share one device)
export const students = pgTable("students", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id").notNull(), // FK to devices table
  studentName: text("student_name").notNull(),
  studentEmail: text("student_email"), // Google Workspace email for auto-detection
  gradeLevel: text("grade_level"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertStudentSchema = createInsertSchema(students).omit({ id: true, createdAt: true });
export type InsertStudent = z.infer<typeof insertStudentSchema>;
export type Student = typeof students.$inferSelect;

// Real-time status tracking (in-memory, not persisted)
export interface StudentStatus {
  studentId: string;
  deviceId: string;
  deviceName?: string;
  studentName: string;
  classId: string;
  gradeLevel?: string;
  activeTabTitle: string;
  activeTabUrl: string;
  favicon?: string;
  lastSeenAt: number;
  isSharing: boolean;
  status: 'online' | 'idle' | 'offline';
}

// Heartbeat data
export const heartbeats = pgTable("heartbeats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id").notNull(),
  studentId: text("student_id"), // Nullable - which student is currently active
  activeTabTitle: text("active_tab_title").notNull(),
  activeTabUrl: text("active_tab_url").notNull(),
  favicon: text("favicon"),
  timestamp: timestamp("timestamp").notNull().default(sql`now()`),
});

export const insertHeartbeatSchema = createInsertSchema(heartbeats).omit({ id: true, timestamp: true });
export type InsertHeartbeat = z.infer<typeof insertHeartbeatSchema>;
export type Heartbeat = typeof heartbeats.$inferSelect;

// Event logging for audit
export const events = pgTable("events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id").notNull(),
  studentId: text("student_id"), // Nullable - which student triggered the event
  eventType: text("event_type").notNull(), // 'tab_change', 'consent_granted', 'consent_revoked', 'blocked_domain', 'student_switched'
  metadata: jsonb("metadata"),
  timestamp: timestamp("timestamp").notNull().default(sql`now()`),
});

export const insertEventSchema = createInsertSchema(events).omit({ id: true, timestamp: true });
export type InsertEvent = z.infer<typeof insertEventSchema>;
export type Event = typeof events.$inferSelect;

// Class rosters
export const rosters = pgTable("rosters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  classId: text("class_id").notNull(),
  className: text("class_name").notNull(),
  deviceIds: text("device_ids").array().notNull().default(sql`'{}'::text[]`),
  uploadedAt: timestamp("uploaded_at").notNull().default(sql`now()`),
});

export const insertRosterSchema = createInsertSchema(rosters).omit({ id: true, uploadedAt: true });
export type InsertRoster = z.infer<typeof insertRosterSchema>;
export type Roster = typeof rosters.$inferSelect;

// Settings
export const settings = pgTable("settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull().unique(),
  schoolName: text("school_name").notNull(),
  wsSharedKey: text("ws_shared_key").notNull(),
  retentionHours: text("retention_hours").notNull().default("24"),
  blockedDomains: text("blocked_domains").array().default(sql`'{}'::text[]`),
  allowedDomains: text("allowed_domains").array().default(sql`'{}'::text[]`),
  ipAllowlist: text("ip_allowlist").array().default(sql`'{}'::text[]`),
  gradeLevels: text("grade_levels").array().default(sql`'{6,7,8,9,10,11,12}'::text[]`),
});

export const insertSettingsSchema = createInsertSchema(settings).omit({ id: true });
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settings.$inferSelect;

// Login request schema
export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginSchema>;

// WebRTC signaling
export interface SignalMessage {
  type: 'offer' | 'answer' | 'ice-candidate';
  data: any;
  deviceId: string;
}

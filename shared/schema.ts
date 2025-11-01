import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";
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
  screenLocked: boolean;
  sceneActive: boolean; // True if a scene is applied (vs single-domain lock)
  activeSceneName?: string; // Name of the currently active scene
  screenLockedSetAt?: number; // Timestamp when server set screenLocked (prevents heartbeat overwrite)
  cameraActive: boolean;
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
  screenLocked: boolean("screen_locked").default(false),
  sceneActive: boolean("scene_active").default(false), // True if scene is active (vs single-domain lock)
  activeSceneName: text("active_scene_name"), // Name of the currently active scene
  isSharing: boolean("is_sharing").default(false),
  cameraActive: boolean("camera_active").default(false),
  timestamp: timestamp("timestamp").notNull().default(sql`now()`),
}, (table) => ({
  // Indexes for performance with 30-day retention
  timestampIdx: index("heartbeats_timestamp_idx").on(table.timestamp),
  studentIdIdx: index("heartbeats_student_id_idx").on(table.studentId),
  deviceIdIdx: index("heartbeats_device_id_idx").on(table.deviceId),
  studentTimestampIdx: index("heartbeats_student_timestamp_idx").on(table.studentId, table.timestamp),
}));

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

// Scenes - Activity-based browsing environments
export const scenes = pgTable("scenes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull(),
  sceneName: text("scene_name").notNull(),
  description: text("description"),
  allowedDomains: text("allowed_domains").array().default(sql`'{}'::text[]`),
  blockedDomains: text("blocked_domains").array().default(sql`'{}'::text[]`),
  isDefault: boolean("is_default").default(false),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertSceneSchema = createInsertSchema(scenes).omit({ id: true, createdAt: true });
export type InsertScene = z.infer<typeof insertSceneSchema>;
export type Scene = typeof scenes.$inferSelect;

// Student Groups - For differentiated instruction
export const studentGroups = pgTable("student_groups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull(),
  groupName: text("group_name").notNull(),
  description: text("description"),
  studentIds: text("student_ids").array().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertStudentGroupSchema = createInsertSchema(studentGroups).omit({ id: true, createdAt: true });
export type InsertStudentGroup = z.infer<typeof insertStudentGroupSchema>;
export type StudentGroup = typeof studentGroups.$inferSelect;

// Messages - For teacher-student chat
export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromUserId: text("from_user_id"), // Teacher user ID
  toStudentId: text("to_student_id"), // Student ID (nullable for broadcast)
  message: text("message").notNull(),
  isAnnouncement: boolean("is_announcement").default(false),
  timestamp: timestamp("timestamp").notNull().default(sql`now()`),
});

export const insertMessageSchema = createInsertSchema(messages).omit({ id: true, timestamp: true });
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messages.$inferSelect;

// Check-ins - For student wellbeing polls
export const checkIns = pgTable("check_ins", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: text("student_id").notNull(),
  mood: text("mood").notNull(), // 'happy', 'neutral', 'sad', 'stressed'
  message: text("message"), // Optional message from student
  timestamp: timestamp("timestamp").notNull().default(sql`now()`),
});

export const insertCheckInSchema = createInsertSchema(checkIns).omit({ id: true, timestamp: true });
export type InsertCheckIn = z.infer<typeof insertCheckInSchema>;
export type CheckIn = typeof checkIns.$inferSelect;

// Session table (managed by express-session middleware - don't modify)
export const session = pgTable("session", {
  sid: varchar("sid").primaryKey(),
  sess: jsonb("sess").notNull(),
  expire: timestamp("expire").notNull(),
});

// Settings
export const settings = pgTable("settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull().unique(),
  schoolName: text("school_name").notNull(),
  wsSharedKey: text("ws_shared_key").notNull(),
  retentionHours: text("retention_hours").notNull().default("720"), // 30 days default
  blockedDomains: text("blocked_domains").array().default(sql`'{}'::text[]`),
  allowedDomains: text("allowed_domains").array().default(sql`'{}'::text[]`),
  ipAllowlist: text("ip_allowlist").array().default(sql`'{}'::text[]`),
  gradeLevels: text("grade_levels").array().default(sql`'{6,7,8,9,10,11,12}'::text[]`),
  maxTabsPerStudent: text("max_tabs_per_student"), // Nullable - null means unlimited
  activeSceneId: text("active_scene_id"), // Currently active scene for the school
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

// Remote Control Commands (Phase 1: GoGuardian-style features)
export interface RemoteControlMessage {
  type: 'open-tab' | 'close-tab' | 'lock-screen' | 'unlock-screen' | 'apply-scene' | 'limit-tabs';
  data: {
    url?: string; // For open-tab, lock-screen
    pattern?: string; // For close-tab (URL pattern to match)
    closeAll?: boolean; // For close-tab (close all tabs except allowed)
    locked?: boolean; // For lock-screen
    sceneId?: string; // For apply-scene
    sceneName?: string; // For apply-scene - display name of the scene
    maxTabs?: number; // For limit-tabs
    allowedDomains?: string[]; // For apply-scene
    blockedDomains?: string[]; // For apply-scene
  };
  targetStudentIds?: string[]; // If specified, only apply to these students. If null, apply to all
  targetGrade?: string; // If specified, apply to students in this grade
}

// Chat/Messaging (Phase 2)
export interface ChatMessage {
  type: 'chat' | 'announcement';
  fromUserId?: string;
  fromName?: string;
  toStudentId?: string; // For direct messages
  message: string;
  timestamp: number;
}

// Check-in Request (Phase 3)
export interface CheckInRequest {
  type: 'check-in-request';
  question: string;
  options: string[]; // e.g., ['😊 Happy', '😐 Neutral', '😔 Sad', '😰 Stressed']
}

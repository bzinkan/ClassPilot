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
  deviceId: text("device_id"), // FK to devices table - nullable to support email-first approach
  studentName: text("student_name").notNull(),
  studentEmail: text("student_email"), // Google Workspace email for auto-detection
  gradeLevel: text("grade_level"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  schoolId: text("school_id").notNull(), // Existing field in database
  emailLc: text("email_lc"), // Existing field - lowercase email for case-insensitive lookups
  studentStatus: text("student_status").notNull(), // Existing field in database
});

export const insertStudentSchema = createInsertSchema(students).omit({ id: true, createdAt: true });
export type InsertStudent = z.infer<typeof insertStudentSchema>;
export type Student = typeof students.$inferSelect;

// Student-Device join table - Tracks which students use which devices (email-first multi-device support)
export const studentDevices = pgTable("student_devices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: text("student_id").notNull(), // FK to students table
  deviceId: text("device_id").notNull(), // FK to devices table
  firstSeenAt: timestamp("first_seen_at").notNull().default(sql`now()`),
  lastSeenAt: timestamp("last_seen_at").notNull().default(sql`now()`),
});

export const insertStudentDeviceSchema = createInsertSchema(studentDevices).omit({ id: true, firstSeenAt: true, lastSeenAt: true });
export type InsertStudentDevice = z.infer<typeof insertStudentDeviceSchema>;
export type StudentDevice = typeof studentDevices.$inferSelect;

// Real-time status tracking (in-memory, not persisted)
export interface StudentStatus {
  studentId: string;
  deviceId?: string | null; // NULLABLE: Email-first students may not have deviceId yet
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
  flightPathActive: boolean; // True if a flight path is applied (vs single-domain lock)
  activeFlightPathName?: string; // Name of the currently active flight path
  screenLockedSetAt?: number; // Timestamp when server set screenLocked (prevents heartbeat overwrite)
  cameraActive: boolean;
  currentUrlDuration?: number; // Duration in seconds spent on current URL
  viewMode?: 'url' | 'thumb' | 'live'; // Display mode for the student tile
  status: 'online' | 'idle' | 'offline';
  statusKey?: string; // Composite key: studentId-deviceId (for multi-device tracking)
}

// Helper function to create consistent composite keys for student status tracking
// This allows the same student to appear multiple times (once per device)
export function makeStatusKey(studentId: string, deviceId?: string | null): string {
  return `${studentId}-${deviceId || 'no-device'}`;
}

// Aggregated student status - combines all devices for a single student
// Used for dashboard display (one tile per student)
export interface AggregatedStudentStatus {
  studentId: string;
  studentEmail?: string; // Primary identity
  studentName: string;
  gradeLevel?: string;
  classId: string;
  
  // Multi-device awareness
  deviceCount: number; // How many devices this student is using
  devices: Array<{
    deviceId: string;
    deviceName?: string;
    status: 'online' | 'idle' | 'offline';
    lastSeenAt: number;
  }>;
  
  // Aggregated status (best across all devices)
  status: 'online' | 'idle' | 'offline'; // Online if ANY device online
  lastSeenAt: number; // Most recent across all devices
  
  // Primary device data (from most active device)
  primaryDeviceId?: string | null; // Device with most recent activity (nullable for email-first)
  deviceName?: string; // Name of primary device (for display compatibility)
  activeTabTitle: string;
  activeTabUrl: string;
  favicon?: string;
  isSharing: boolean;
  screenLocked: boolean;
  flightPathActive: boolean;
  activeFlightPathName?: string;
  cameraActive: boolean;
  currentUrlDuration?: number;
  viewMode?: 'url' | 'thumb' | 'live';
}

// Heartbeat data
// PHASE 3: Email-first identity - studentEmail is now the primary identifier
export const heartbeats = pgTable("heartbeats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id").notNull(),
  studentId: text("student_id"), // LEGACY - kept for backward compatibility, will be removed after migration
  studentEmail: text("student_email"), // NEW: Primary student identifier (email-first)
  schoolId: text("school_id"), // NEW: Multi-tenant support
  activeTabTitle: text("active_tab_title").notNull(),
  activeTabUrl: text("active_tab_url"),  // Now nullable to skip chrome-internal URLs
  favicon: text("favicon"),
  screenLocked: boolean("screen_locked").default(false),
  flightPathActive: boolean("flight_path_active").default(false), // True if flight path is active (vs single-domain lock)
  activeFlightPathName: text("active_flight_path_name"), // Name of the currently active flight path
  isSharing: boolean("is_sharing").default(false),
  cameraActive: boolean("camera_active").default(false),
  timestamp: timestamp("timestamp").notNull().default(sql`now()`),
}, (table) => ({
  // Indexes for performance with 30-day retention
  timestampIdx: index("heartbeats_timestamp_idx").on(table.timestamp),
  studentIdIdx: index("heartbeats_student_id_idx").on(table.studentId),
  studentEmailIdx: index("heartbeats_student_email_idx").on(table.studentEmail), // NEW: Email-based lookup
  deviceIdIdx: index("heartbeats_device_id_idx").on(table.deviceId),
  studentTimestampIdx: index("heartbeats_student_timestamp_idx").on(table.studentId, table.timestamp),
  emailTimestampIdx: index("heartbeats_email_timestamp_idx").on(table.studentEmail, table.timestamp), // NEW: Email+time lookup
  schoolEmailIdx: index("heartbeats_school_email_idx").on(table.schoolId, table.studentEmail), // NEW: Multi-tenant email lookup
}));

// Email normalization helper for consistent lookups
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  
  // Remove +tags from Gmail (user+tag@gmail.com → user@gmail.com)
  const atIndex = trimmed.indexOf('@');
  if (atIndex === -1) return trimmed;
  
  const localPart = trimmed.substring(0, atIndex);
  const domain = trimmed.substring(atIndex);
  
  // Remove +tag from local part
  const plusIndex = localPart.indexOf('+');
  const cleanLocal = plusIndex === -1 ? localPart : localPart.substring(0, plusIndex);
  
  return cleanLocal + domain;
}

// Heartbeat validation: Require EITHER studentId OR (studentEmail + schoolId)
export const insertHeartbeatSchema = createInsertSchema(heartbeats)
  .omit({ id: true, timestamp: true })
  .superRefine((data, ctx) => {
    const hasStudentId = !!data.studentId;
    const hasEmail = !!data.studentEmail && !!data.schoolId;
    
    if (!hasStudentId && !hasEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either studentId or (studentEmail + schoolId) must be provided",
        path: ['studentId'],
      });
    }
    
    // Normalize email if provided
    if (data.studentEmail) {
      data.studentEmail = normalizeEmail(data.studentEmail);
    }
  });

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

// Flight Paths - Activity-based browsing environments (teacher-scoped)
export const flightPaths = pgTable("flight_paths", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull(),
  teacherId: text("teacher_id"), // FK to users table - nullable for backward compatibility, will be NOT NULL after migration
  flightPathName: text("flight_path_name").notNull(),
  description: text("description"),
  allowedDomains: text("allowed_domains").array().default(sql`'{}'::text[]`),
  blockedDomains: text("blocked_domains").array().default(sql`'{}'::text[]`),
  isDefault: boolean("is_default").default(false),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertFlightPathSchema = createInsertSchema(flightPaths)
  .omit({ id: true, createdAt: true })
  .extend({
    blockedDomains: z.array(z.string()).default([]),
  });
export type InsertFlightPath = z.infer<typeof insertFlightPathSchema>;
export type FlightPath = typeof flightPaths.$inferSelect;

// Student Groups - For differentiated instruction (teacher-scoped)
export const studentGroups = pgTable("student_groups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull(),
  teacherId: text("teacher_id"), // FK to users table - nullable for backward compatibility, will be NOT NULL after migration
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
  activeFlightPathId: text("active_flight_path_id"), // Currently active flight path for the school
  enableTrackingHours: boolean("enable_tracking_hours").default(false), // Enable school-hours-only tracking
  trackingStartTime: text("tracking_start_time").default("08:00"), // School start time (24-hour format, e.g., "08:00")
  trackingEndTime: text("tracking_end_time").default("15:00"), // School end time (24-hour format, e.g., "15:00")
  schoolTimezone: text("school_timezone").default("America/New_York"), // School timezone (IANA format, e.g., "America/New_York")
  trackingDays: text("tracking_days").array().default(sql`'{Monday,Tuesday,Wednesday,Thursday,Friday}'::text[]`), // Days of the week when tracking is active
});

export const insertSettingsSchema = createInsertSchema(settings).omit({ id: true });
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settings.$inferSelect;

// Teacher-specific settings (overrides school-wide defaults)
export const teacherSettings = pgTable("teacher_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  teacherId: text("teacher_id").notNull().unique(), // FK to users table
  maxTabsPerStudent: text("max_tabs_per_student"), // Nullable - null means unlimited (inherits from school settings)
  allowedDomains: text("allowed_domains").array().default(sql`'{}'::text[]`), // Teacher-specific allowed domains
  blockedDomains: text("blocked_domains").array().default(sql`'{}'::text[]`), // Teacher-specific blocked domains
  defaultFlightPathId: text("default_flight_path_id"), // Default flight path for this teacher's students
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const insertTeacherSettingsSchema = createInsertSchema(teacherSettings).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTeacherSettings = z.infer<typeof insertTeacherSettingsSchema>;
export type TeacherSettings = typeof teacherSettings.$inferSelect;

// Teacher-Student join table (supports co-teaching - multiple teachers per student)
export const teacherStudents = pgTable("teacher_students", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  teacherId: text("teacher_id").notNull(), // FK to users table
  studentId: text("student_id").notNull(), // FK to students table
  assignedAt: timestamp("assigned_at").notNull().default(sql`now()`),
});

export const insertTeacherStudentSchema = createInsertSchema(teacherStudents).omit({ id: true, assignedAt: true });
export type InsertTeacherStudent = z.infer<typeof insertTeacherStudentSchema>;
export type TeacherStudent = typeof teacherStudents.$inferSelect;

// Dashboard Tabs - User-customizable filter tabs for the dashboard
export const dashboardTabs = pgTable("dashboard_tabs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  teacherId: text("teacher_id").notNull(), // FK to users table
  label: text("label").notNull(), // Display label like "Grade 7", "Robotics Club", "Flagged"
  filterType: text("filter_type").notNull(), // 'grade', 'group', 'status', 'multi-group', 'all'
  filterValue: jsonb("filter_value"), // JSON for complex filters (e.g., multi-group OR conditions, status criteria)
  order: text("order").notNull().default("0"), // For ordering tabs
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertDashboardTabSchema = createInsertSchema(dashboardTabs).omit({ id: true, createdAt: true });
export type InsertDashboardTab = z.infer<typeof insertDashboardTabSchema>;
export type DashboardTab = typeof dashboardTabs.$inferSelect;

// Groups - Class rosters (e.g., "7th Science P3", "Robotics Club")
export const groups = pgTable("groups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull(),
  teacherId: text("teacher_id").notNull(), // FK to users table - which teacher owns this group
  name: text("name").notNull(), // e.g., "7th Science P3", "Robotics Club"
  description: text("description"), // Optional description
  periodLabel: text("period_label"), // Optional period label (e.g., "P3", "10:10-10:55")
  gradeLevel: text("grade_level"), // Optional grade level for filtering
  groupType: text("group_type").notNull().default("teacher_created"), // "admin_class" | "teacher_small_group" | "teacher_created" (legacy)
  parentGroupId: text("parent_group_id"), // FK to groups.id - for small groups within official classes (nullable)
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertGroupSchema = createInsertSchema(groups).omit({ id: true, createdAt: true });
export type InsertGroup = z.infer<typeof insertGroupSchema>;
export type Group = typeof groups.$inferSelect;

// Group Students - Many-to-many join table between groups and students
export const groupStudents = pgTable("group_students", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  groupId: text("group_id").notNull(), // FK to groups table
  studentId: text("student_id").notNull(), // FK to students table
  assignedAt: timestamp("assigned_at").notNull().default(sql`now()`),
});

export const insertGroupStudentSchema = createInsertSchema(groupStudents).omit({ id: true, assignedAt: true });
export type InsertGroupStudent = z.infer<typeof insertGroupStudentSchema>;
export type GroupStudent = typeof groupStudents.$inferSelect;

// Sessions - Active teaching periods (bell-to-bell classroom sessions)
export const sessions = pgTable("sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  groupId: text("group_id").notNull(), // FK to groups table - which class is being taught
  teacherId: text("teacher_id").notNull(), // FK to users table - which teacher started the session
  startTime: timestamp("start_time").notNull().default(sql`now()`),
  endTime: timestamp("end_time"), // NULL means currently active, timestamp means ended
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertSessionSchema = createInsertSchema(sessions).omit({ id: true, createdAt: true, startTime: true });
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;

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

// Remote Control Commands (Phase 1: Classroom control features)
export interface RemoteControlMessage {
  type: 'open-tab' | 'close-tab' | 'lock-screen' | 'unlock-screen' | 'apply-flight-path' | 'limit-tabs';
  data: {
    url?: string; // For open-tab, lock-screen
    pattern?: string; // For close-tab (URL pattern to match)
    closeAll?: boolean; // For close-tab (close all tabs except allowed)
    locked?: boolean; // For lock-screen
    flightPathId?: string; // For apply-flight-path
    flightPathName?: string; // For apply-flight-path - display name of the flight path
    maxTabs?: number; // For limit-tabs
    allowedDomains?: string[]; // For apply-flight-path
    blockedDomains?: string[]; // For apply-flight-path
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

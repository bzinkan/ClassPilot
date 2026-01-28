import {
  type User,
  type InsertUser,
  type School,
  type InsertSchool,
  type Device,
  type InsertDevice,
  type Student,
  type InsertStudent,
  type StudentStatus,
  type AggregatedStudentStatus,
  type GoogleOAuthToken,
  type InsertGoogleOAuthToken,
  type ClassroomCourse,
  type InsertClassroomCourse,
  type InsertClassroomCourseStudent,
  type StudentSession,
  type InsertStudentSession,
  type Heartbeat,
  type InsertHeartbeat,
  type Event,
  type InsertEvent,
  type Roster,
  type InsertRoster,
  type Settings,
  type InsertSettings,
  type TeacherSettings,
  type InsertTeacherSettings,
  type TeacherStudent,
  type InsertTeacherStudent,
  type DashboardTab,
  type InsertDashboardTab,
  type Group,
  type InsertGroup,
  type GroupStudent,
  type InsertGroupStudent,
  type Session,
  type InsertSession,
  type FlightPath,
  type InsertFlightPath,
  type BlockList,
  type InsertBlockList,
  type StudentGroup,
  type InsertStudentGroup,
  type Message,
  type InsertMessage,
  type CheckIn,
  type InsertCheckIn,
  type Poll,
  type InsertPoll,
  type PollResponse,
  type InsertPollResponse,
  type Subgroup,
  type InsertSubgroup,
  type SubgroupMember,
  type InsertSubgroupMember,
  type DbChatMessage,
  type InsertChatMessage,
  type AuditLog,
  type InsertAuditLog,
  type TabInfo, // All-tabs tracking
  makeStatusKey,
  insertSettingsSchema,
  schools,
  users,
  devices,
  students,
  googleOAuthTokens,
  classroomCourses,
  classroomCourseStudents,
  studentDevices, // PHASE 3: Student-device join table
  studentSessions, // SESSION-BASED TRACKING: Student sessions table
  heartbeats,
  events,
  rosters,
  settings,
  teacherSettings,
  teacherStudents,
  dashboardTabs,
  groups,
  groupStudents,
  sessions,
  flightPaths,
  blockLists,
  studentGroups,
  messages,
  checkIns,
  polls,
  pollResponses,
  subgroups,
  subgroupMembers,
  chatMessages,
  auditLogs,
  normalizeEmail,
} from "@shared/schema";
import { randomUUID } from "crypto";
import { db } from "./db";
import { eq, desc, lt, sql as drizzleSql, sql, inArray, isNull, and } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./security/crypto";

type GoogleOAuthTokenUpsert = Pick<InsertGoogleOAuthToken, "scope" | "tokenType" | "expiryDate"> & {
  refreshToken?: string | null;
};

type GoogleOAuthTokenUpdateSet = Partial<
  Pick<typeof googleOAuthTokens.$inferInsert, "scope" | "tokenType" | "expiryDate" | "refreshToken">
> & { updatedAt: Date };

const ENCRYPTED_SECRET_PARTS = 3;
type SettingsUpsertInput = Partial<typeof settings.$inferInsert>;

function isEncryptedSecret(value?: string | null): value is string {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== ENCRYPTED_SECRET_PARTS) return false;
  return parts.every((part) => part.length > 0);
}

function normalizeExpiryDate(value: GoogleOAuthTokenUpsert["expiryDate"]): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function buildDefaultSettingsInput({
  schoolId,
  schoolName,
  wsSharedKey,
}: {
  schoolId: string;
  schoolName?: string | null;
  wsSharedKey?: string | null;
}): InsertSettings {
  return {
    schoolId,
    schoolName: schoolName ?? "School",
    wsSharedKey: wsSharedKey ?? process.env.WS_SHARED_KEY ?? "change-this-key",
    retentionHours: "24",
    blockedDomains: [],
    allowedDomains: [],
    ipAllowlist: [],
    gradeLevels: ["6", "7", "8", "9", "10", "11", "12"],
    maxTabsPerStudent: null,
    activeFlightPathId: null,
    enableTrackingHours: false,
    trackingStartTime: "08:00",
    trackingEndTime: "15:00",
    schoolTimezone: "America/New_York",
    trackingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    afterHoursMode: "off" as Settings["afterHoursMode"],
  };
}

function normalizeSettings(input: Settings): Settings;
function normalizeSettings<T extends Partial<Settings>>(
  input: T
): T & {
  allowedDomains: string[] | null;
  blockedDomains: string[] | null;
  ipAllowlist: string[] | null;
  gradeLevels: string[] | null;
  trackingDays: string[] | null;
  afterHoursMode: Settings["afterHoursMode"];
};
function normalizeSettings<T extends Partial<Settings>>(input: T) {
  return {
    ...input,
    allowedDomains: input.allowedDomains ?? null,
    blockedDomains: input.blockedDomains ?? null,
    ipAllowlist: input.ipAllowlist ?? null,
    gradeLevels: input.gradeLevels ?? null,
    trackingDays: input.trackingDays ?? null,
    afterHoursMode: (input.afterHoursMode ?? "off") as Settings["afterHoursMode"],
  };
}

type AfterHoursMode = Settings["afterHoursMode"];

function normalizeSettingsForInsert(
  input: Partial<Settings> & Pick<Settings, "schoolId" | "schoolName" | "wsSharedKey">
): typeof settings.$inferInsert {
  return {
    ...input,
    allowedDomains: input.allowedDomains ?? null,
    blockedDomains: input.blockedDomains ?? null,
    ipAllowlist: input.ipAllowlist ?? null,
    gradeLevels: input.gradeLevels ?? null,
    trackingDays: input.trackingDays ?? null,
    retentionHours: input.retentionHours ?? "24",
    afterHoursMode: (input.afterHoursMode ?? "off") as AfterHoursMode,
  };
}

export interface IStorage {
  // Schools
  getSchool(id: string): Promise<School | undefined>;
  getSchoolByDomain(domain: string): Promise<School | undefined>;
  getAllSchools(includeDeleted?: boolean): Promise<School[]>;
  createSchool(school: InsertSchool): Promise<School>;
  updateSchool(id: string, updates: Partial<InsertSchool>): Promise<School | undefined>;
  bumpSchoolSessionVersion(schoolId: string): Promise<number>;
  setSchoolActiveState(
    schoolId: string,
    state: { isActive?: boolean; planStatus?: string; disabledReason?: string | null }
  ): Promise<School | undefined>;
  deleteSchool(id: string): Promise<boolean>;
  softDeleteSchool(id: string): Promise<School | undefined>; // Soft delete (set deletedAt)
  restoreSchool(id: string): Promise<School | undefined>; // Restore soft-deleted school (clear deletedAt)
  
  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUsersBySchool(schoolId: string): Promise<User[]>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updates: Partial<InsertUser>): Promise<User | undefined>;
  getAllUsers(): Promise<User[]>;
  deleteUser(id: string): Promise<boolean>;

  // Devices (Chromebooks)
  getDevice(deviceId: string): Promise<Device | undefined>;
  getDevicesBySchool(schoolId: string): Promise<Device[]>;
  registerDevice(device: InsertDevice): Promise<Device>;
  updateDevice(deviceId: string, updates: Partial<Omit<InsertDevice, 'deviceId'>>): Promise<Device | undefined>;
  deleteDevice(deviceId: string): Promise<boolean>;

  // Students (assigned to devices)
  getStudent(studentId: string): Promise<Student | undefined>;
  getStudentByEmail(email: string): Promise<Student | undefined>;
  getStudentBySchoolEmail(schoolId: string, emailLc: string): Promise<Student | undefined>; // PHASE 3: Email-first lookup with multi-tenancy
  getStudentBySchoolGoogleUserId(schoolId: string, googleUserId: string): Promise<Student | undefined>;
  getStudentsByDevice(schoolId: string, deviceId: string): Promise<Student[]>;
  getStudentsBySchool(schoolId: string): Promise<Student[]>;
  createStudent(student: InsertStudent): Promise<Student>;
  updateStudent(studentId: string, updates: Partial<InsertStudent>): Promise<Student | undefined>;
  deleteStudent(studentId: string): Promise<boolean>;
  upsertStudentDevice(studentId: string, deviceId: string): Promise<void>; // PHASE 3: Track student-device relationships

  // Google OAuth tokens
  getGoogleOAuthTokens(userId: string): Promise<GoogleOAuthToken | undefined>;
  upsertGoogleOAuthTokens(userId: string, token: GoogleOAuthTokenUpsert): Promise<GoogleOAuthToken>;

  // Google Classroom roster sync
  upsertClassroomCourse(course: InsertClassroomCourse): Promise<ClassroomCourse>;
  getClassroomCourse(schoolId: string, courseId: string): Promise<ClassroomCourse | undefined>;
  getClassroomCoursesForSchool(schoolId: string): Promise<ClassroomCourse[]>;
  getClassroomCourseStudentCount(schoolId: string, courseId: string): Promise<number>;
  getClassroomCourseStudentIds(schoolId: string, courseId: string): Promise<string[]>;
  replaceCourseStudents(
    schoolId: string,
    courseId: string,
    studentIdsWithMeta: Array<Pick<InsertClassroomCourseStudent, "studentId" | "googleUserId" | "studentEmailLc">>
  ): Promise<number>;

  // Student Sessions - INDUSTRY STANDARD SESSION-BASED TRACKING
  // Tracks "Student X is on Device Y RIGHT NOW"
  findActiveStudentSession(studentId: string): Promise<StudentSession | undefined>; // Find active session for a student
  findActiveStudentSessionByDevice(deviceId: string): Promise<StudentSession | undefined>; // Find active session for a device
  startStudentSession(studentId: string, deviceId: string): Promise<StudentSession>; // Start new student session
  endStudentSession(sessionId: string): Promise<void>; // End a student session (set isActive=false, endedAt=now)
  updateStudentSessionHeartbeat(sessionId: string, lastSeenAt: Date): Promise<void>; // Update lastSeenAt timestamp
  expireStaleStudentSessions(maxAgeSeconds: number): Promise<number>; // Auto-expire old student sessions, returns count

  // Student Status (in-memory tracking - per student, not device)
  getStudentStatus(studentId: string): Promise<StudentStatus | undefined>;
  getStudentStatusesBySchool(schoolId: string): Promise<StudentStatus[]>;
  getStudentStatusesAggregatedBySchool(schoolId: string): Promise<AggregatedStudentStatus[]>; // One entry per student
  updateStudentStatus(status: StudentStatus): Promise<void>;
  getActiveStudentForDevice(deviceId: string): Promise<Student | undefined>;
  setActiveStudentForDevice(deviceId: string, studentId: string | null): Promise<void>;

  // Heartbeats
  addHeartbeat(heartbeat: InsertHeartbeat, allOpenTabs?: TabInfo[]): Promise<Heartbeat>;
  getHeartbeatsByDevice(deviceId: string, limit?: number): Promise<Heartbeat[]>;
  getHeartbeatsByStudent(studentId: string, limit?: number): Promise<Heartbeat[]>;
  getHeartbeatsBySchool(schoolId: string): Promise<Heartbeat[]>;
  cleanupOldHeartbeats(retentionHours: number): Promise<number>;

  // Events
  addEvent(event: InsertEvent): Promise<Event>;
  getEventsByDevice(deviceId: string): Promise<Event[]>;
  getEventsByStudent(studentId: string): Promise<Event[]>;

  // Rosters
  getRoster(classId: string): Promise<Roster | undefined>;
  getRostersBySchool(schoolId: string): Promise<Roster[]>;
  upsertRoster(roster: InsertRoster): Promise<Roster>;

  // Settings
  getSettingsBySchoolId(schoolId: string): Promise<Settings | null>;
  upsertSettingsForSchool(schoolId: string, input: SettingsUpsertInput): Promise<Settings>;
  ensureSettingsForSchool(schoolId: string): Promise<Settings>;

  // Teacher Settings
  getTeacherSettings(teacherId: string): Promise<TeacherSettings | undefined>;
  upsertTeacherSettings(settings: InsertTeacherSettings): Promise<TeacherSettings>;
  
  // Teacher-Student Relationships
  assignStudentToTeacher(teacherId: string, studentId: string): Promise<TeacherStudent>;
  unassignStudentFromTeacher(teacherId: string, studentId: string): Promise<boolean>;
  getTeacherStudents(teacherId: string): Promise<string[]>; // Returns student IDs
  getStudentTeachers(studentId: string): Promise<string[]>; // Returns teacher IDs

  // Dashboard Tabs
  getDashboardTabs(teacherId: string): Promise<DashboardTab[]>;
  getDashboardTab(id: string): Promise<DashboardTab | undefined>;
  createDashboardTab(tab: InsertDashboardTab): Promise<DashboardTab>;
  updateDashboardTab(id: string, updates: Partial<InsertDashboardTab>): Promise<DashboardTab | undefined>;
  deleteDashboardTab(id: string): Promise<boolean>;

  // Groups (Class Rosters)
  getGroup(id: string): Promise<Group | undefined>;
  getGroupsBySchool(schoolId: string): Promise<Group[]>;
  getGroupsByTeacher(teacherId: string): Promise<Group[]>;
  createGroup(group: InsertGroup): Promise<Group>;
  updateGroup(id: string, updates: Partial<InsertGroup>): Promise<Group | undefined>;
  deleteGroup(id: string): Promise<boolean>;
  
  // Group Students (Many-to-many)
  getGroupStudents(groupId: string): Promise<string[]>; // Returns student IDs
  assignStudentToGroup(groupId: string, studentId: string): Promise<GroupStudent>;
  unassignStudentFromGroup(groupId: string, studentId: string): Promise<boolean>;
  getStudentGroups(studentId: string): Promise<string[]>; // Returns group IDs
  
  // Sessions
  getSession(id: string): Promise<Session | undefined>;
  getActiveSessionByTeacher(teacherId: string): Promise<Session | undefined>;
  getActiveSessions(schoolId: string): Promise<Session[]>; // All currently active sessions
  getSessionsBySchool(schoolId: string): Promise<Session[]>;
  startSession(session: InsertSession): Promise<Session>;
  endSession(sessionId: string): Promise<Session | undefined>;

  // Flight Paths (teacher-scoped)
  getFlightPath(id: string): Promise<FlightPath | undefined>;
  getFlightPathsBySchool(schoolId: string): Promise<FlightPath[]>;
  getFlightPathsByTeacher(teacherId: string): Promise<FlightPath[]>; // Teacher-specific flight paths
  createFlightPath(flightPath: InsertFlightPath): Promise<FlightPath>;
  updateFlightPath(id: string, updates: Partial<InsertFlightPath>): Promise<FlightPath | undefined>;
  deleteFlightPath(id: string): Promise<boolean>;

  // Block Lists (teacher-scoped)
  getBlockList(id: string): Promise<BlockList | undefined>;
  getBlockListsBySchool(schoolId: string): Promise<BlockList[]>;
  getBlockListsByTeacher(teacherId: string): Promise<BlockList[]>;
  createBlockList(blockList: InsertBlockList): Promise<BlockList>;
  updateBlockList(id: string, updates: Partial<InsertBlockList>): Promise<BlockList | undefined>;
  deleteBlockList(id: string): Promise<boolean>;

  // Student Groups (teacher-scoped)
  getStudentGroup(id: string): Promise<StudentGroup | undefined>;
  getStudentGroupsBySchool(schoolId: string): Promise<StudentGroup[]>;
  getStudentGroupsByTeacher(teacherId: string): Promise<StudentGroup[]>; // Teacher-specific groups
  createStudentGroup(group: InsertStudentGroup): Promise<StudentGroup>;
  updateStudentGroup(id: string, updates: Partial<InsertStudentGroup>): Promise<StudentGroup | undefined>;
  deleteStudentGroup(id: string): Promise<boolean>;

  // Messages
  getMessage(id: string): Promise<Message | undefined>;
  getMessagesByStudent(studentId: string): Promise<Message[]>;
  getAllMessages(): Promise<Message[]>;
  createMessage(message: InsertMessage): Promise<Message>;

  // Check-ins
  getCheckIn(id: string): Promise<CheckIn | undefined>;
  getCheckInsByStudent(studentId: string): Promise<CheckIn[]>;
  getAllCheckIns(): Promise<CheckIn[]>;
  createCheckIn(checkIn: InsertCheckIn): Promise<CheckIn>;

  // Polls
  getPoll(id: string): Promise<Poll | undefined>;
  getPollsBySession(sessionId: string): Promise<Poll[]>;
  getActivePollsBySession(sessionId: string): Promise<Poll[]>;
  createPoll(poll: InsertPoll): Promise<Poll>;
  closePoll(pollId: string): Promise<Poll | undefined>;

  // Poll Responses
  getPollResponse(id: string): Promise<PollResponse | undefined>;
  getPollResponsesByPoll(pollId: string): Promise<PollResponse[]>;
  createPollResponse(response: InsertPollResponse): Promise<PollResponse>;
  getPollResults(pollId: string): Promise<{ option: number; count: number }[]>;

  // Subgroups
  getSubgroup(id: string): Promise<Subgroup | undefined>;
  getSubgroupsByGroup(groupId: string): Promise<Subgroup[]>;
  createSubgroup(subgroup: InsertSubgroup): Promise<Subgroup>;
  updateSubgroup(id: string, updates: Partial<InsertSubgroup>): Promise<Subgroup | undefined>;
  deleteSubgroup(id: string): Promise<boolean>;

  // Subgroup Members
  getSubgroupMembers(subgroupId: string): Promise<string[]>; // Returns student IDs
  addSubgroupMember(subgroupId: string, studentId: string): Promise<SubgroupMember>;
  removeSubgroupMember(subgroupId: string, studentId: string): Promise<boolean>;
  getStudentSubgroups(studentId: string): Promise<string[]>; // Returns subgroup IDs

  // Chat Messages (Two-Way Chat)
  createChatMessage(message: InsertChatMessage): Promise<DbChatMessage>;
  getStudentMessagesForSchool(schoolId: string, options?: { since?: Date; limit?: number }): Promise<DbChatMessage[]>;
  getChatMessagesBySession(sessionId: string): Promise<DbChatMessage[]>;
  deleteChatMessage(messageId: string): Promise<boolean>;

  // Audit Logs
  createAuditLog(log: InsertAuditLog): Promise<AuditLog>;
  getAuditLogsBySchool(schoolId: string, options?: {
    action?: string;
    userId?: string;
    since?: Date;
    until?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ logs: AuditLog[]; total: number }>;
}

export class MemStorage implements IStorage {
  private schools: Map<string, School>;
  private users: Map<string, User>;
  private devices: Map<string, Device>;
  private students: Map<string, Student>; // Keyed by student ID
  private activeStudents: Map<string, string>; // deviceId -> studentId
  private studentStatuses: Map<string, StudentStatus>; // Keyed by studentId-deviceId composite
  private sessions: Map<string, StudentSession>; // Session-based tracking (industry standard)
  private heartbeats: Heartbeat[];
  private events: Event[];
  private googleOAuthTokens: Map<string, GoogleOAuthToken>;
  private classroomCourses: Map<string, ClassroomCourse>;
  private classroomCourseStudents: Map<string, Array<Pick<InsertClassroomCourseStudent, "studentId" | "googleUserId" | "studentEmailLc">>>;
  private rosters: Map<string, Roster>;
  private settingsBySchool: Map<string, Settings>;
  private teacherSettings: Map<string, TeacherSettings>;
  private teacherStudents: TeacherStudent[];
  private flightPaths: Map<string, FlightPath>;
  private blockLists: Map<string, BlockList>;
  private studentGroups: Map<string, StudentGroup>;
  private messages: Message[];
  private checkIns: CheckIn[];

  constructor() {
    this.schools = new Map();
    this.users = new Map();
    this.devices = new Map();
    this.students = new Map();
    this.activeStudents = new Map();
    this.studentStatuses = new Map();
    this.sessions = new Map();
    this.heartbeats = [];
    this.events = [];
    this.googleOAuthTokens = new Map();
    this.classroomCourses = new Map();
    this.classroomCourseStudents = new Map();
    this.rosters = new Map();
    this.settingsBySchool = new Map();
    this.teacherSettings = new Map();
    this.teacherStudents = [];
    this.flightPaths = new Map();
    this.blockLists = new Map();
    this.studentGroups = new Map();
    this.messages = [];
    this.checkIns = [];
  }

  // Helper to calculate status from lastSeenAt
  // Thresholds designed for 60-second heartbeat intervals:
  // - "online" = last heartbeat within 90s (allows for network delays)
  // - "idle" = last heartbeat within 3 minutes
  // - "offline" = no heartbeat for over 3 minutes
  private calculateStatus(lastSeenAt: number): 'online' | 'idle' | 'offline' {
    const timeSinceLastSeen = Date.now() - lastSeenAt;
    if (timeSinceLastSeen < 90000) return 'online';  // 90 seconds
    if (timeSinceLastSeen < 180000) return 'idle';   // 3 minutes
    return 'offline';
  }

  // Helper to execute function only when deviceId is non-null
  private withDeviceId<T>(deviceId: string | null | undefined, fn: (deviceId: string) => T): T | undefined {
    if (deviceId && deviceId !== null) {
      return fn(deviceId);
    }
    return undefined;
  }

  // Schools
  async getSchool(id: string): Promise<School | undefined> {
    return this.schools.get(id);
  }

  async getSchoolByDomain(domain: string): Promise<School | undefined> {
    return Array.from(this.schools.values()).find(
      (school) => school.domain.toLowerCase() === domain.toLowerCase()
    );
  }

  async getAllSchools(includeDeleted = false): Promise<School[]> {
    const allSchools = Array.from(this.schools.values());
    if (includeDeleted) {
      return allSchools;
    }
    return allSchools.filter(school => !school.deletedAt);
  }

  async createSchool(insertSchool: InsertSchool): Promise<School> {
    const id = randomUUID();
    const status = insertSchool.status || "trial";
    const planStatus = insertSchool.planStatus ?? "active";
    const planTier = insertSchool.planTier ?? "trial";
    const isActive = insertSchool.isActive ?? status !== "suspended";
    const school: School = {
      id,
      name: insertSchool.name,
      domain: insertSchool.domain,
      status,
      isActive,
      planTier,
      planStatus,
      activeUntil: insertSchool.activeUntil ?? null,
      stripeSubscriptionId: insertSchool.stripeSubscriptionId ?? null,
      disabledAt: insertSchool.disabledAt ?? null,
      disabledReason: insertSchool.disabledReason ?? null,
      schoolSessionVersion: insertSchool.schoolSessionVersion ?? 1,
      maxLicenses: insertSchool.maxLicenses ?? 100,
      usedLicenses: 0,
      createdAt: new Date(),
      trialEndsAt: insertSchool.trialEndsAt ?? null,
      deletedAt: null,
      lastActivityAt: null,
      // Super Admin configurable tracking hours
      trackingStartHour: insertSchool.trackingStartHour ?? 7,
      trackingEndHour: insertSchool.trackingEndHour ?? 17,
      is24HourEnabled: insertSchool.is24HourEnabled ?? false,
      schoolTimezone: insertSchool.schoolTimezone ?? "America/New_York",
      // Billing
      billingEmail: insertSchool.billingEmail ?? null,
      stripeCustomerId: insertSchool.stripeCustomerId ?? null,
      lastPaymentAmount: insertSchool.lastPaymentAmount ?? null,
      lastPaymentDate: insertSchool.lastPaymentDate ?? null,
      totalPaid: insertSchool.totalPaid ?? 0,
    };
    this.schools.set(id, school);
    return school;
  }

  async updateSchool(id: string, updates: Partial<InsertSchool>): Promise<School | undefined> {
    const school = this.schools.get(id);
    if (!school) return undefined;
    
    Object.assign(school, updates);
    this.schools.set(id, school);
    return school;
  }

  async bumpSchoolSessionVersion(schoolId: string): Promise<number> {
    const school = this.schools.get(schoolId);
    if (!school) return 0;
    const nextVersion = (school.schoolSessionVersion ?? 1) + 1;
    school.schoolSessionVersion = nextVersion;
    this.schools.set(schoolId, school);
    return nextVersion;
  }

  async setSchoolActiveState(
    schoolId: string,
    state: { isActive?: boolean; planStatus?: string; disabledReason?: string | null }
  ): Promise<School | undefined> {
    const school = this.schools.get(schoolId);
    if (!school) return undefined;

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
      await this.bumpSchoolSessionVersion(schoolId);
    } else if (isReactivating) {
      school.disabledAt = null;
      school.disabledReason = null;
      await this.bumpSchoolSessionVersion(schoolId);
    } else if (state.disabledReason !== undefined) {
      school.disabledReason = state.disabledReason;
    }

    this.schools.set(schoolId, school);
    return school;
  }

  async deleteSchool(id: string): Promise<boolean> {
    return this.schools.delete(id);
  }

  async softDeleteSchool(id: string): Promise<School | undefined> {
    const school = this.schools.get(id);
    if (!school) return undefined;
    
    school.deletedAt = new Date();
    this.schools.set(id, school);
    return school;
  }

  async restoreSchool(id: string): Promise<School | undefined> {
    const school = this.schools.get(id);
    if (!school) return undefined;
    
    school.deletedAt = null;
    this.schools.set(id, school);
    return school;
  }

  // Users
  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.email.toLowerCase() === email.toLowerCase()
    );
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username
    );
  }

  async getUsersBySchool(schoolId: string): Promise<User[]> {
    return Array.from(this.users.values()).filter(
      (user) => user.schoolId === schoolId
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = {
      id,
      email: insertUser.email,
      username: insertUser.username ?? null,
      password: insertUser.password ?? null,
      role: insertUser.role || 'teacher',
      schoolId: insertUser.schoolId ?? null,
      displayName: insertUser.displayName ?? null,
      googleId: insertUser.googleId ?? null,
      profileImageUrl: insertUser.profileImageUrl ?? null,
      schoolName: insertUser.schoolName ?? null,
      createdAt: new Date(),
      lastLoginAt: null,
    };
    this.users.set(id, user);
    return user;
  }

  async updateUser(id: string, updates: Partial<InsertUser>): Promise<User | undefined> {
    const user = this.users.get(id);
    if (!user) return undefined;
    
    Object.assign(user, updates);
    this.users.set(id, user);
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return Array.from(this.users.values());
  }

  async deleteUser(id: string): Promise<boolean> {
    return this.users.delete(id);
  }

  async getGoogleOAuthTokens(userId: string): Promise<GoogleOAuthToken | undefined> {
    const token = this.googleOAuthTokens.get(userId);
    if (!token) return undefined;

    const refreshToken = isEncryptedSecret(token.refreshToken)
      ? decryptSecret(token.refreshToken)
      : token.refreshToken;

    return { ...token, refreshToken };
  }

  async upsertGoogleOAuthTokens(
    userId: string,
    token: GoogleOAuthTokenUpsert
  ): Promise<GoogleOAuthToken> {
    const existing = this.googleOAuthTokens.get(userId);
    const now = new Date();
    const existingRefreshToken = existing?.refreshToken ?? null;
    const hasEncryptedToken = isEncryptedSecret(existingRefreshToken);
    const providedRefreshToken = token.refreshToken ?? undefined;
    const refreshTokenToStore = providedRefreshToken
      ? encryptSecret(providedRefreshToken)
      : existingRefreshToken
        ? (hasEncryptedToken ? existingRefreshToken : encryptSecret(existingRefreshToken))
        : null;

    if (!refreshTokenToStore) {
      throw new Error("Refresh token is required to store Google OAuth credentials.");
    }

    const saved: GoogleOAuthToken = {
      id: existing?.id ?? randomUUID(),
      userId,
      refreshToken: refreshTokenToStore,
      scope: token.scope ?? null,
      tokenType: token.tokenType ?? null,
      expiryDate: token.expiryDate ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.googleOAuthTokens.set(userId, saved);
    return saved;
  }

  // Devices
  async getDevice(deviceId: string): Promise<Device | undefined> {
    return this.devices.get(deviceId);
  }

  async getDevicesBySchool(schoolId: string): Promise<Device[]> {
    return Array.from(this.devices.values()).filter((device) => device.schoolId === schoolId);
  }

  async registerDevice(insertDevice: InsertDevice): Promise<Device> {
    const device: Device = {
      deviceId: insertDevice.deviceId,
      deviceName: insertDevice.deviceName ?? null,
      schoolId: insertDevice.schoolId,
      classId: insertDevice.classId,
      registeredAt: new Date(),
    };
    this.devices.set(device.deviceId, device);
    return device;
  }

  async updateDevice(deviceId: string, updates: Partial<Omit<InsertDevice, 'deviceId'>>): Promise<Device | undefined> {
    const device = this.devices.get(deviceId);
    if (!device) return undefined;
    
    Object.assign(device, updates);
    this.devices.set(deviceId, device);
    return device;
  }

  async deleteDevice(deviceId: string): Promise<boolean> {
    const existingDevice = this.devices.get(deviceId);
    const existed = this.devices.has(deviceId);
    this.devices.delete(deviceId);
    
    // Delete all students assigned to this device
    const studentsToDelete = Array.from(this.students.values())
      .filter(s => s.deviceId === deviceId);
    for (const student of studentsToDelete) {
      this.students.delete(student.id);
      this.studentStatuses.delete(student.id);
    }
    if (studentsToDelete.length > 0 && existingDevice) {
      const school = this.schools.get(existingDevice.schoolId);
      if (school) {
        school.usedLicenses = Math.max((school.usedLicenses ?? 0) - studentsToDelete.length, 0);
        this.schools.set(school.id, school);
      }
    }
    
    // Clear active student mapping
    this.activeStudents.delete(deviceId);
    
    // Delete related data
    this.heartbeats = this.heartbeats.filter(h => h.deviceId !== deviceId);
    this.events = this.events.filter(e => e.deviceId !== deviceId);
    
    return existed;
  }

  // Students
  async getStudent(studentId: string): Promise<Student | undefined> {
    return this.students.get(studentId);
  }

  async getStudentByEmail(email: string): Promise<Student | undefined> {
    return Array.from(this.students.values())
      .find(s => s.studentEmail === email);
  }

  async getStudentBySchoolEmail(schoolId: string, emailLc: string): Promise<Student | undefined> {
    return Array.from(this.students.values())
      .find(s => s.schoolId === schoolId && s.emailLc === emailLc);
  }

  async getStudentBySchoolGoogleUserId(schoolId: string, googleUserId: string): Promise<Student | undefined> {
    return Array.from(this.students.values())
      .find(s => s.schoolId === schoolId && s.googleUserId === googleUserId);
  }

  async getStudentsByDevice(schoolId: string, deviceId: string): Promise<Student[]> {
    return Array.from(this.students.values())
      .filter(s => s.deviceId === deviceId && s.schoolId === schoolId);
  }

  async getStudentsBySchool(schoolId: string): Promise<Student[]> {
    return Array.from(this.students.values()).filter((student) => student.schoolId === schoolId);
  }

  async createStudent(insertStudent: InsertStudent): Promise<Student> {
    const id = randomUUID();
    const student: Student = {
      id,
      deviceId: insertStudent.deviceId ?? null,
      studentName: insertStudent.studentName,
      studentEmail: insertStudent.studentEmail ?? null,
      emailLc: insertStudent.emailLc ?? null, // Email normalization
      googleUserId: insertStudent.googleUserId ?? null,
      gradeLevel: insertStudent.gradeLevel ?? null,
      schoolId: insertStudent.schoolId,
      studentStatus: insertStudent.studentStatus,
      createdAt: new Date(),
    };
    this.students.set(id, student);

    const school = this.schools.get(insertStudent.schoolId);
    if (school) {
      school.usedLicenses = (school.usedLicenses ?? 0) + 1;
      this.schools.set(school.id, school);
    }
    
    // Status will be created when first heartbeat arrives (no epoch timestamps)
    console.log(`Created student ${id} - status will be initialized on first heartbeat`);
    
    return student;
  }

  async updateStudent(studentId: string, updates: Partial<InsertStudent>): Promise<Student | undefined> {
    const student = this.students.get(studentId);
    if (!student) return undefined;
    
    const oldDeviceId = student.deviceId;
    Object.assign(student, updates);
    this.students.set(studentId, student);
    
    // If deviceId changed, we need to move the status to a new key
    if (updates.deviceId !== undefined && oldDeviceId !== student.deviceId) {
      const oldKey = makeStatusKey(studentId, oldDeviceId);
      const status = this.studentStatuses.get(oldKey);
      
      if (status) {
        // Delete old key
        this.studentStatuses.delete(oldKey);
        
        // Update deviceId and related fields
        status.deviceId = student.deviceId;
        if (student.deviceId) {
          const device = this.devices.get(student.deviceId);
          if (device) {
            status.deviceName = device.deviceName ?? undefined;
            status.classId = device.classId;
          }
        } else {
          status.deviceName = undefined;
          status.classId = '';
        }
        
        // Set with new key
        const newKey = makeStatusKey(studentId, student.deviceId);
        status.statusKey = newKey;
        this.studentStatuses.set(newKey, status);
      }
      } else {
        // DeviceId didn't change, just update fields
        const statusKey = makeStatusKey(studentId, student.deviceId);
        const status = this.studentStatuses.get(statusKey);
        if (status) {
          status.schoolId = student.schoolId;
          if (updates.studentName) {
            status.studentName = updates.studentName;
          }
        if (updates.gradeLevel !== undefined) {
          status.gradeLevel = updates.gradeLevel ?? undefined;
        }
        this.studentStatuses.set(statusKey, status);
      }
    }
    
    return student;
  }

  async deleteStudent(studentId: string): Promise<boolean> {
    const student = this.students.get(studentId);
    if (!student) return false;
    
    const existed = this.students.delete(studentId);
    const school = this.schools.get(student.schoolId);
    if (school) {
      school.usedLicenses = Math.max((school.usedLicenses ?? 0) - 1, 0);
      this.schools.set(school.id, school);
    }
    // Delete status using composite key
    const statusKey = makeStatusKey(studentId, student.deviceId);
    this.studentStatuses.delete(statusKey);
    
    // Clear from active students if this student is active
    const entries = Array.from(this.activeStudents.entries());
    for (const [deviceId, activeStudentId] of entries) {
      if (activeStudentId === studentId) {
        this.activeStudents.delete(deviceId);
      }
    }
    
    // Delete teacher-student assignments
    this.teacherStudents = this.teacherStudents.filter(ts => ts.studentId !== studentId);
    
    // Delete group-student assignments (remove studentId from all groups)
    for (const [groupId, group] of Array.from(this.studentGroups.entries())) {
      if (group.studentIds && group.studentIds.includes(studentId)) {
        group.studentIds = group.studentIds.filter((id: string) => id !== studentId);
        this.studentGroups.set(groupId, group);
      }
    }
    
    // Delete related data
    this.heartbeats = this.heartbeats.filter(h => h.studentId !== studentId);
    this.events = this.events.filter(e => e.studentId !== studentId);
    this.checkIns = this.checkIns.filter(c => c.studentId !== studentId);
    
    return existed;
  }

  async upsertStudentDevice(studentId: string, deviceId: string): Promise<void> {
    // For in-memory storage, student-device tracking is implicit via student.deviceId
    // No-op for now, but DrizzleStorage will update student_devices table
    return Promise.resolve();
  }

  async upsertClassroomCourse(course: InsertClassroomCourse): Promise<ClassroomCourse> {
    const key = `${course.schoolId}:${course.courseId}`;
    const existing = this.classroomCourses.get(key);
    const now = new Date();
    const saved: ClassroomCourse = {
      id: existing?.id ?? randomUUID(),
      schoolId: course.schoolId,
      courseId: course.courseId,
      name: course.name,
      section: course.section ?? null,
      room: course.room ?? null,
      descriptionHeading: course.descriptionHeading ?? null,
      ownerId: course.ownerId ?? null,
      lastSyncedAt: course.lastSyncedAt ?? now,
      createdAt: existing?.createdAt ?? now,
    };
    this.classroomCourses.set(key, saved);
    return saved;
  }

  async getClassroomCourse(schoolId: string, courseId: string): Promise<ClassroomCourse | undefined> {
    const key = `${schoolId}:${courseId}`;
    return this.classroomCourses.get(key);
  }

  async getClassroomCoursesForSchool(schoolId: string): Promise<ClassroomCourse[]> {
    return Array.from(this.classroomCourses.values()).filter(c => c.schoolId === schoolId);
  }

  async getClassroomCourseStudentCount(schoolId: string, courseId: string): Promise<number> {
    const key = `${schoolId}:${courseId}`;
    const students = this.classroomCourseStudents.get(key);
    return students?.length || 0;
  }

  async getClassroomCourseStudentIds(schoolId: string, courseId: string): Promise<string[]> {
    const key = `${schoolId}:${courseId}`;
    const students = this.classroomCourseStudents.get(key);
    return students?.map(s => s.studentId) || [];
  }

  async replaceCourseStudents(
    schoolId: string,
    courseId: string,
    studentIdsWithMeta: Array<Pick<InsertClassroomCourseStudent, "studentId" | "googleUserId" | "studentEmailLc">>
  ): Promise<number> {
    const key = `${schoolId}:${courseId}`;
    this.classroomCourseStudents.set(key, studentIdsWithMeta);
    return studentIdsWithMeta.length;
  }

  // Student Sessions - INDUSTRY STANDARD SESSION-BASED TRACKING
  async findActiveStudentSession(studentId: string): Promise<StudentSession | undefined> {
    return Array.from(this.sessions.values()).find(
      session => session.studentId === studentId && session.isActive
    );
  }

  async findActiveStudentSessionByDevice(deviceId: string): Promise<StudentSession | undefined> {
    return Array.from(this.sessions.values()).find(
      session => session.deviceId === deviceId && session.isActive
    );
  }

  async startStudentSession(studentId: string, deviceId: string): Promise<StudentSession> {
    // INDUSTRY STANDARD SWAP LOGIC: Enforce one active session per student/device
    
    // 1. Check if student already has an active session
    const existingStudentSession = await this.findActiveStudentSession(studentId);
    
    // 2. If student active on SAME device, just update heartbeat (no-op, return existing)
    if (existingStudentSession && existingStudentSession.deviceId === deviceId) {
      await this.updateStudentSessionHeartbeat(existingStudentSession.id, new Date());
      return existingStudentSession;
    }
    
    // 3. If student active on DIFFERENT device, end old session (student switched devices)
    if (existingStudentSession && existingStudentSession.deviceId !== deviceId) {
      await this.endStudentSession(existingStudentSession.id);
    }
    
    // 4. Check if device already has an active session (another student logged in)
    const existingDeviceSession = await this.findActiveStudentSessionByDevice(deviceId);
    
    // 5. If different student on this device, end their session (device eviction)
    if (existingDeviceSession && existingDeviceSession.studentId !== studentId) {
      await this.endStudentSession(existingDeviceSession.id);
    }
    
    // 6. Create new active session
    const now = new Date();
    const session: StudentSession = {
      id: randomUUID(),
      studentId,
      deviceId,
      startedAt: now,
      lastSeenAt: now,
      endedAt: null,
      isActive: true,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async endStudentSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isActive = false;
      session.endedAt = new Date();
      this.sessions.set(sessionId, session);
      
      // Sync in-memory status map to mark student offline (defensive guard for null deviceId)
      if (session.deviceId) {
        const statusKey = makeStatusKey(session.studentId, session.deviceId);
        const status = this.studentStatuses.get(statusKey);
        if (status) {
          status.lastSeenAt = 0; // Force status to 'offline'
          this.studentStatuses.set(statusKey, status);
        }
      }
    }
  }

  async updateStudentSessionHeartbeat(sessionId: string, lastSeenAt: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastSeenAt = lastSeenAt;
      this.sessions.set(sessionId, session);
    }
  }

  async expireStaleStudentSessions(maxAgeSeconds: number): Promise<number> {
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - maxAgeSeconds * 1000);
    let expiredCount = 0;

    for (const session of Array.from(this.sessions.values())) {
      if (session.isActive && session.lastSeenAt < cutoffTime) {
        session.isActive = false;
        session.endedAt = now;
        this.sessions.set(session.id, session);
        expiredCount++;
        
        // Sync in-memory status map to mark student offline (defensive guard for null deviceId)
        if (session.deviceId) {
          const statusKey = makeStatusKey(session.studentId, session.deviceId);
          const status = this.studentStatuses.get(statusKey);
          if (status) {
            status.lastSeenAt = 0; // Force status to 'offline'
            this.studentStatuses.set(statusKey, status);
          }
        }
      }
    }

    return expiredCount;
  }

  // Student Status
  async getStudentStatus(studentId: string): Promise<StudentStatus | undefined> {
    const status = this.studentStatuses.get(studentId);
    if (!status) return undefined;
    
    return {
      ...status,
      status: this.calculateStatus(status.lastSeenAt),
    };
  }

  async getStudentStatusesBySchool(schoolId: string): Promise<StudentStatus[]> {
    const statuses = Array.from(this.studentStatuses.values()).filter((status) => {
      if (!status.schoolId) return false;
      return status.schoolId === schoolId;
    });
    
    return statuses.map(status => ({
      ...status,
      status: this.calculateStatus(status.lastSeenAt),
    }));
  }

  async getStudentStatusesAggregatedBySchool(schoolId: string): Promise<AggregatedStudentStatus[]> {
    const allStatuses = await this.getStudentStatusesBySchool(schoolId);
    
    // Group statuses by studentId
    const statusesByStudent = new Map<string, StudentStatus[]>();
    for (const status of allStatuses) {
      const existing = statusesByStudent.get(status.studentId) || [];
      existing.push(status);
      statusesByStudent.set(status.studentId, existing);
    }
    
    // Aggregate each student's devices
    const aggregated: AggregatedStudentStatus[] = [];
    for (const [studentId, deviceStatuses] of Array.from(statusesByStudent.entries())) {
      // Find most recent device (primary device)
      const primaryStatus = deviceStatuses.reduce((latest: StudentStatus, current: StudentStatus) => 
        current.lastSeenAt > latest.lastSeenAt ? current : latest
      );
      
      // Determine best status across all devices (Online > Idle > Offline)
      const statusPriority: Record<string, number> = { online: 3, idle: 2, offline: 1 };
      const bestStatus = deviceStatuses.reduce((best: StudentStatus, current: StudentStatus) => 
        statusPriority[current.status] > statusPriority[best.status] ? current : best
      );
      
      // Get student email from student record
      const student = this.students.get(studentId);
      
      aggregated.push({
        studentId,
        studentEmail: student?.studentEmail || undefined,
        studentName: primaryStatus.studentName,
        gradeLevel: primaryStatus.gradeLevel,
        classId: primaryStatus.classId,
        
        // Multi-device info
        deviceCount: deviceStatuses.length,
        devices: deviceStatuses.map((s: StudentStatus) => ({
          deviceId: s.deviceId,
          deviceName: s.deviceName,
          status: s.status,
          lastSeenAt: s.lastSeenAt,
        })),
        
        // Aggregated status
        status: bestStatus.status,
        lastSeenAt: Math.max(...deviceStatuses.map((s: StudentStatus) => s.lastSeenAt)),
        
        // Primary device data (most recent)
        primaryDeviceId: primaryStatus.deviceId,
        deviceName: primaryStatus.deviceName, // Device name from primary device
        activeTabTitle: primaryStatus.activeTabTitle,
        activeTabUrl: primaryStatus.activeTabUrl,
        favicon: primaryStatus.favicon,
        // Merge allOpenTabs from ALL devices (include deviceId, skip devices without valid ID)
        allOpenTabs: (() => {
          const mergedTabs: Array<TabInfo & {deviceId: string}> = [];
          deviceStatuses.forEach(deviceStatus => {
            // Only include tabs from devices with valid (non-empty) deviceId
            if (!deviceStatus.deviceId || deviceStatus.deviceId.trim() === '') {
              console.warn(`⚠️ Skipping tabs for student ${studentId} - device has no valid ID`);
              return;
            }
            deviceStatus.allOpenTabs?.forEach(tab => {
              mergedTabs.push({ ...tab, deviceId: deviceStatus.deviceId! }); // deviceId guaranteed non-empty here
            });
          });
          return mergedTabs.length > 0 ? mergedTabs : undefined;
        })(),
        isSharing: primaryStatus.isSharing,
        screenLocked: primaryStatus.screenLocked,
        flightPathActive: primaryStatus.flightPathActive,
        activeFlightPathName: primaryStatus.activeFlightPathName,
        cameraActive: primaryStatus.cameraActive,
        currentUrlDuration: primaryStatus.currentUrlDuration,
        viewMode: primaryStatus.viewMode,
      });
    }
    
    return aggregated;
  }

  async updateStudentStatus(status: StudentStatus): Promise<void> {
    const statusKey = makeStatusKey(status.studentId, status.deviceId);
    this.studentStatuses.set(statusKey, status);
  }

  async getActiveStudentForDevice(deviceId: string): Promise<Student | undefined> {
    const activeStudentId = this.activeStudents.get(deviceId);
    if (!activeStudentId) return undefined;
    return this.students.get(activeStudentId);
  }

  async setActiveStudentForDevice(deviceId: string, studentId: string | null): Promise<void> {
    if (studentId === null) {
      this.activeStudents.delete(deviceId);
    } else {
      this.activeStudents.set(deviceId, studentId);
    }
  }

  // Heartbeats
  async addHeartbeat(insertHeartbeat: InsertHeartbeat, allOpenTabs?: TabInfo[]): Promise<Heartbeat> {
    const heartbeat: Heartbeat = {
      id: randomUUID(),
      deviceId: insertHeartbeat.deviceId,
      schoolId: insertHeartbeat.schoolId ?? null,
      studentEmail: insertHeartbeat.studentEmail ?? null,
      studentId: insertHeartbeat.studentId ?? null,
      activeTabTitle: insertHeartbeat.activeTabTitle ?? null,
      activeTabUrl: insertHeartbeat.activeTabUrl ?? null,
      favicon: insertHeartbeat.favicon ?? null,
      screenLocked: insertHeartbeat.screenLocked ?? false,
      flightPathActive: insertHeartbeat.flightPathActive ?? false,
      activeFlightPathName: insertHeartbeat.activeFlightPathName ?? null,
      isSharing: insertHeartbeat.isSharing ?? false,
      cameraActive: insertHeartbeat.cameraActive ?? false,
      timestamp: new Date(),
    };
    this.heartbeats.push(heartbeat);
    
    // Map to canonical studentId (same logic as DatabaseStorage)
    let canonicalStudentId = heartbeat.studentId;
    
    // Try to find studentId if not provided
    if (!canonicalStudentId) {
      // First try: Check active student mapping
      const activeStudentId = this.activeStudents.get(heartbeat.deviceId);
      if (activeStudentId) {
        canonicalStudentId = activeStudentId;
      } else if (heartbeat.studentEmail && heartbeat.schoolId) {
        // Second try: Look up by email (EMAIL-FIRST FLOW)
        const studentByEmail = await this.getStudentBySchoolEmail(heartbeat.schoolId, normalizeEmail(heartbeat.studentEmail));
        if (studentByEmail) {
          canonicalStudentId = studentByEmail.id;
          // Cache mapping for future heartbeats
          this.activeStudents.set(heartbeat.deviceId, studentByEmail.id);
        }
      }
    }
    
    // Update or create student status if we have a studentId
    if (canonicalStudentId) {
      // Use composite key: studentId-deviceId (allows same student on multiple devices)
      const statusKey = makeStatusKey(canonicalStudentId, heartbeat.deviceId);
      let status = this.studentStatuses.get(statusKey);
      
      // If status doesn't exist, create it from student data
      if (!status) {
        const student = this.students.get(canonicalStudentId);
        if (student) {
          const device = this.devices.get(heartbeat.deviceId);
          status = {
            schoolId: heartbeat.schoolId ?? student.schoolId ?? undefined,
            studentId: student.id,
            deviceId: heartbeat.deviceId, // Use heartbeat's deviceId (current device)
            deviceName: device?.deviceName ?? undefined,
            studentName: student.studentName,
            classId: device?.classId || '',
            gradeLevel: student.gradeLevel ?? undefined,
            activeTabTitle: heartbeat.activeTabTitle || "",
            activeTabUrl: heartbeat.activeTabUrl || "",
            favicon: heartbeat.favicon ?? undefined,
            allOpenTabs, // 🆕 All tabs (in-memory only)
            lastSeenAt: Date.now(),
            isSharing: heartbeat.isSharing ?? false,
            screenLocked: heartbeat.screenLocked ?? false,
            flightPathActive: heartbeat.flightPathActive ?? false,
            activeFlightPathName: heartbeat.activeFlightPathName || undefined,
            cameraActive: heartbeat.cameraActive ?? false,
            status: 'online',
            statusKey, // Store composite key for reference
          };
          this.studentStatuses.set(statusKey, status);
          console.log('Created StudentStatus for student:', student.id);
        } else {
          console.warn('Heartbeat has studentId but student not found in database:', heartbeat.studentId);
        }
      } else {
        // Update existing status
        const now = Date.now();
        if (heartbeat.schoolId) {
          status.schoolId = heartbeat.schoolId;
        }
        status.activeTabTitle = heartbeat.activeTabTitle || "";
        status.activeTabUrl = heartbeat.activeTabUrl || "";
        status.favicon = heartbeat.favicon ?? undefined;
        status.allOpenTabs = allOpenTabs; // 🆕 Update all tabs (in-memory only)
        
        // Only update screenLocked/flightPath from heartbeat if server hasn't set it recently (within 15 seconds)
        // This prevents heartbeat race conditions where the extension hasn't yet processed the server command
        // 15 seconds covers the worst-case heartbeat interval plus network delays
        const serverSetRecently = status.screenLockedSetAt && (now - status.screenLockedSetAt) < 15000;
        if (!serverSetRecently) {
          status.screenLocked = heartbeat.screenLocked ?? false;
          status.flightPathActive = heartbeat.flightPathActive ?? false;
          status.activeFlightPathName = heartbeat.activeFlightPathName || undefined;
        }

        status.isSharing = heartbeat.isSharing ?? false;
        status.cameraActive = heartbeat.cameraActive ?? false;
        status.lastSeenAt = now;
        status.status = this.calculateStatus(now);
        
        // Calculate current URL duration using canonical student ID
        status.currentUrlDuration = this.calculateCurrentUrlDurationMem(canonicalStudentId, heartbeat.activeTabUrl);
        
        this.studentStatuses.set(statusKey, status);
      }
    }
    
    return heartbeat;
  }

  // Helper function to calculate duration on current URL (MemStorage)
  // @param canonicalStudentId - The resolved student ID (handles email-first students)
  private calculateCurrentUrlDurationMem(canonicalStudentId: string, currentUrl: string | null): number {
    // Handle null URL
    if (!currentUrl) {
      return 0;
    }
    
    // Get recent heartbeats for this student (filter by canonical studentId)
    // This works because canonicalStudentId is set on heartbeats during addHeartbeat
    const studentHeartbeats = this.heartbeats
      .filter(h => h.studentId === canonicalStudentId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    if (studentHeartbeats.length === 0) {
      return 10; // First heartbeat, default to 10 seconds
    }
    
    // Find consecutive heartbeats with the same URL (going backwards from most recent)
    let consecutiveCount = 0;
    let startTime: Date | null = null;
    let endTime: Date | null = null;
    
    for (let i = studentHeartbeats.length - 1; i >= 0; i--) {
      const hb = studentHeartbeats[i];
      if (hb.activeTabUrl === currentUrl) {
        consecutiveCount++;
        endTime = endTime || new Date(hb.timestamp);
        startTime = new Date(hb.timestamp);
      } else {
        break; // Stop when URL changes
      }
    }
    
    if (consecutiveCount === 0 || !startTime || !endTime) {
      return 10; // Default to 10 seconds
    }
    
    // Calculate duration: time span + one heartbeat interval (10s)
    const timeSpanSeconds = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);
    return timeSpanSeconds + 10;
  }

  async getHeartbeatsByDevice(deviceId: string, limit: number = 1000): Promise<Heartbeat[]> {
    return this.heartbeats
      .filter(h => h.deviceId === deviceId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }

  async getHeartbeatsByStudent(studentId: string, limit: number = 1000): Promise<Heartbeat[]> {
    return this.heartbeats
      .filter(h => h.studentId === studentId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }

  async getHeartbeatsBySchool(schoolId: string): Promise<Heartbeat[]> {
    return this.heartbeats
      .filter(h => h.schoolId === schoolId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  async cleanupOldHeartbeats(retentionHours: number): Promise<number> {
    const cutoffTime = Date.now() - retentionHours * 60 * 60 * 1000;
    const initialCount = this.heartbeats.length;
    
    this.heartbeats = this.heartbeats.filter(
      h => new Date(h.timestamp).getTime() > cutoffTime
    );
    
    return initialCount - this.heartbeats.length;
  }

  // Events
  async addEvent(insertEvent: InsertEvent): Promise<Event> {
    const event: Event = {
      id: randomUUID(),
      deviceId: insertEvent.deviceId,
      studentId: insertEvent.studentId ?? null,
      eventType: insertEvent.eventType,
      metadata: insertEvent.metadata ?? null,
      timestamp: new Date(),
    };
    this.events.push(event);
    return event;
  }

  async getEventsByDevice(deviceId: string): Promise<Event[]> {
    return this.events
      .filter(e => e.deviceId === deviceId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  async getEventsByStudent(studentId: string): Promise<Event[]> {
    return this.events
      .filter(e => e.studentId === studentId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  // Rosters
  async getRoster(classId: string): Promise<Roster | undefined> {
    return this.rosters.get(classId);
  }

  async getRostersBySchool(schoolId: string): Promise<Roster[]> {
    const schoolDeviceIds = new Set(
      Array.from(this.devices.values())
        .filter((device) => device.schoolId === schoolId)
        .map((device) => device.deviceId)
    );
    return Array.from(this.rosters.values()).filter((roster) =>
      roster.deviceIds.some((deviceId) => schoolDeviceIds.has(deviceId))
    );
  }

  async upsertRoster(insertRoster: InsertRoster): Promise<Roster> {
    const existing = this.rosters.get(insertRoster.classId);
    const roster: Roster = {
      id: existing?.id || randomUUID(),
      classId: insertRoster.classId,
      className: insertRoster.className,
      deviceIds: insertRoster.deviceIds ?? [],
      uploadedAt: new Date(),
    };
    this.rosters.set(roster.classId, roster);
    return roster;
  }

  // Settings
  async getSettingsBySchoolId(schoolId: string): Promise<Settings | null> {
    return this.settingsBySchool.get(schoolId) ?? null;
  }

  async ensureSettingsForSchool(schoolId: string): Promise<Settings> {
    const existing = await this.getSettingsBySchoolId(schoolId);
    if (existing) {
      return existing;
    }
    const schoolName = this.schools.get(schoolId)?.name;
    const defaults = buildDefaultSettingsInput({ schoolId, schoolName });
    const settings = normalizeSettingsForInsert({
      id: randomUUID(),
      ...defaults,
    }) as Settings;
    this.settingsBySchool.set(schoolId, settings);
    return settings;
  }

  async upsertSettingsForSchool(schoolId: string, input: SettingsUpsertInput): Promise<Settings> {
    const existing = await this.getSettingsBySchoolId(schoolId);
    const sanitizedInput = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined)
    ) as SettingsUpsertInput;
    const schoolName = input.schoolName ?? this.schools.get(schoolId)?.name;
    const defaults = buildDefaultSettingsInput({
      schoolId,
      schoolName,
      wsSharedKey: input.wsSharedKey,
    });
    const parsed = insertSettingsSchema.parse({
      ...defaults,
      ...sanitizedInput,
      schoolId,
    });
    const settings = normalizeSettingsForInsert({
      id: existing?.id ?? randomUUID(),
      ...parsed,
    }) as Settings;
    this.settingsBySchool.set(schoolId, settings);
    return settings;
  }

  async getSettings(): Promise<Settings | undefined> {
    throw new Error("Unscoped settings are forbidden. Use getSettingsBySchoolId(schoolId).");
  }

  async upsertSettings(_insertSettings: InsertSettings): Promise<Settings> {
    throw new Error("Unscoped settings are forbidden. Use upsertSettingsForSchool(schoolId, input).");
  }

  // Teacher Settings
  async getTeacherSettings(teacherId: string): Promise<TeacherSettings | undefined> {
    return this.teacherSettings.get(teacherId);
  }

  async upsertTeacherSettings(insertSettings: InsertTeacherSettings): Promise<TeacherSettings> {
    const existing = this.teacherSettings.get(insertSettings.teacherId);
    const teacherSettings: TeacherSettings = {
      id: existing?.id || randomUUID(),
      teacherId: insertSettings.teacherId,
      maxTabsPerStudent: insertSettings.maxTabsPerStudent ?? null,
      allowedDomains: insertSettings.allowedDomains ?? null,
      blockedDomains: insertSettings.blockedDomains ?? null,
      defaultFlightPathId: insertSettings.defaultFlightPathId ?? null,
      createdAt: existing?.createdAt || new Date(),
      updatedAt: new Date(),
    };
    this.teacherSettings.set(insertSettings.teacherId, teacherSettings);
    return teacherSettings;
  }

  // Teacher-Student Relationships
  async assignStudentToTeacher(teacherId: string, studentId: string): Promise<TeacherStudent> {
    const assignment: TeacherStudent = {
      id: randomUUID(),
      teacherId,
      studentId,
      assignedAt: new Date(),
    };
    this.teacherStudents.push(assignment);
    return assignment;
  }

  async unassignStudentFromTeacher(teacherId: string, studentId: string): Promise<boolean> {
    const index = this.teacherStudents.findIndex(
      (ts) => ts.teacherId === teacherId && ts.studentId === studentId
    );
    if (index >= 0) {
      this.teacherStudents.splice(index, 1);
      return true;
    }
    return false;
  }

  async getTeacherStudents(teacherId: string): Promise<string[]> {
    return this.teacherStudents
      .filter((ts) => ts.teacherId === teacherId)
      .map((ts) => ts.studentId);
  }

  async getStudentTeachers(studentId: string): Promise<string[]> {
    return this.teacherStudents
      .filter((ts) => ts.studentId === studentId)
      .map((ts) => ts.teacherId);
  }

  // Flight Paths
  async getFlightPath(id: string): Promise<FlightPath | undefined> {
    return this.flightPaths.get(id);
  }

  async getFlightPathsBySchool(schoolId: string): Promise<FlightPath[]> {
    return Array.from(this.flightPaths.values()).filter((flightPath) => flightPath.schoolId === schoolId);
  }

  async getFlightPathsByTeacher(teacherId: string): Promise<FlightPath[]> {
    return Array.from(this.flightPaths.values()).filter(
      (fp) => fp.teacherId === teacherId
    );
  }

  async createFlightPath(insertFlightPath: InsertFlightPath): Promise<FlightPath> {
    const id = randomUUID();
    const flightPath: FlightPath = {
      id,
      schoolId: insertFlightPath.schoolId,
      teacherId: insertFlightPath.teacherId ?? null,
      flightPathName: insertFlightPath.flightPathName,
      description: insertFlightPath.description ?? null,
      allowedDomains: insertFlightPath.allowedDomains ?? null,
      blockedDomains: insertFlightPath.blockedDomains ?? null,
      isDefault: insertFlightPath.isDefault ?? false,
      createdAt: new Date(),
    };
    this.flightPaths.set(id, flightPath);
    return flightPath;
  }

  async updateFlightPath(id: string, updates: Partial<InsertFlightPath>): Promise<FlightPath | undefined> {
    const existing = this.flightPaths.get(id);
    if (!existing) return undefined;

    const updated: FlightPath = {
      ...existing,
      ...updates,
    };
    this.flightPaths.set(id, updated);
    return updated;
  }

  async deleteFlightPath(id: string): Promise<boolean> {
    return this.flightPaths.delete(id);
  }

  // Block Lists
  async getBlockList(id: string): Promise<BlockList | undefined> {
    return this.blockLists.get(id);
  }

  async getBlockListsBySchool(schoolId: string): Promise<BlockList[]> {
    return Array.from(this.blockLists.values()).filter((bl) => bl.schoolId === schoolId);
  }

  async getBlockListsByTeacher(teacherId: string): Promise<BlockList[]> {
    return Array.from(this.blockLists.values()).filter((bl) => bl.teacherId === teacherId);
  }

  async createBlockList(insertBlockList: InsertBlockList): Promise<BlockList> {
    const id = randomUUID();
    const blockList: BlockList = {
      id,
      schoolId: insertBlockList.schoolId,
      teacherId: insertBlockList.teacherId,
      name: insertBlockList.name,
      description: insertBlockList.description ?? null,
      blockedDomains: insertBlockList.blockedDomains ?? null,
      isDefault: insertBlockList.isDefault ?? false,
      createdAt: new Date(),
    };
    this.blockLists.set(id, blockList);
    return blockList;
  }

  async updateBlockList(id: string, updates: Partial<InsertBlockList>): Promise<BlockList | undefined> {
    const existing = this.blockLists.get(id);
    if (!existing) return undefined;

    const updated: BlockList = {
      ...existing,
      ...updates,
    };
    this.blockLists.set(id, updated);
    return updated;
  }

  async deleteBlockList(id: string): Promise<boolean> {
    return this.blockLists.delete(id);
  }

  // Student Groups
  async getStudentGroup(id: string): Promise<StudentGroup | undefined> {
    return this.studentGroups.get(id);
  }

  async getStudentGroupsBySchool(schoolId: string): Promise<StudentGroup[]> {
    return Array.from(this.studentGroups.values()).filter((group) => group.schoolId === schoolId);
  }

  async getStudentGroupsByTeacher(teacherId: string): Promise<StudentGroup[]> {
    return Array.from(this.studentGroups.values()).filter(
      (sg) => sg.teacherId === teacherId
    );
  }

  async createStudentGroup(insertGroup: InsertStudentGroup): Promise<StudentGroup> {
    const id = randomUUID();
    const group: StudentGroup = {
      id,
      schoolId: insertGroup.schoolId,
      teacherId: insertGroup.teacherId ?? null,
      groupName: insertGroup.groupName,
      description: insertGroup.description ?? null,
      studentIds: insertGroup.studentIds ?? null,
      createdAt: new Date(),
    };
    this.studentGroups.set(id, group);
    return group;
  }

  async updateStudentGroup(id: string, updates: Partial<InsertStudentGroup>): Promise<StudentGroup | undefined> {
    const existing = this.studentGroups.get(id);
    if (!existing) return undefined;

    const updated: StudentGroup = {
      ...existing,
      ...updates,
    };
    this.studentGroups.set(id, updated);
    return updated;
  }

  async deleteStudentGroup(id: string): Promise<boolean> {
    return this.studentGroups.delete(id);
  }

  // Messages
  async getMessage(id: string): Promise<Message | undefined> {
    return this.messages.find(m => m.id === id);
  }

  async getMessagesByStudent(studentId: string): Promise<Message[]> {
    return this.messages.filter(m => m.toStudentId === studentId || m.toStudentId === null);
  }

  async getAllMessages(): Promise<Message[]> {
    return this.messages;
  }

  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    const id = randomUUID();
    const message: Message = {
      id,
      fromUserId: insertMessage.fromUserId ?? null,
      toStudentId: insertMessage.toStudentId ?? null,
      message: insertMessage.message,
      isAnnouncement: insertMessage.isAnnouncement ?? false,
      timestamp: new Date(),
    };
    this.messages.push(message);
    return message;
  }

  // Check-ins
  async getCheckIn(id: string): Promise<CheckIn | undefined> {
    return this.checkIns.find(c => c.id === id);
  }

  async getCheckInsByStudent(studentId: string): Promise<CheckIn[]> {
    return this.checkIns.filter(c => c.studentId === studentId);
  }

  async getAllCheckIns(): Promise<CheckIn[]> {
    return this.checkIns;
  }

  async createCheckIn(insertCheckIn: InsertCheckIn): Promise<CheckIn> {
    const id = randomUUID();
    const checkIn: CheckIn = {
      id,
      studentId: insertCheckIn.studentId,
      mood: insertCheckIn.mood,
      message: insertCheckIn.message ?? null,
      timestamp: new Date(),
    };
    this.checkIns.push(checkIn);
    return checkIn;
  }

  // Polls (stubs - not used in memory storage)
  private polls: Poll[] = [];
  private pollResponses: PollResponse[] = [];
  private subgroups: Subgroup[] = [];
  private subgroupMembers: SubgroupMember[] = [];

  async getPoll(id: string): Promise<Poll | undefined> {
    return this.polls.find(p => p.id === id);
  }

  async getPollsBySession(sessionId: string): Promise<Poll[]> {
    return this.polls.filter(p => p.sessionId === sessionId);
  }

  async getActivePollsBySession(sessionId: string): Promise<Poll[]> {
    return this.polls.filter(p => p.sessionId === sessionId && p.isActive);
  }

  async createPoll(insertPoll: InsertPoll): Promise<Poll> {
    const poll: Poll = {
      id: randomUUID(),
      sessionId: insertPoll.sessionId,
      teacherId: insertPoll.teacherId,
      question: insertPoll.question,
      options: insertPoll.options,
      isActive: true,
      createdAt: new Date(),
      closedAt: null,
    };
    this.polls.push(poll);
    return poll;
  }

  async closePoll(pollId: string): Promise<Poll | undefined> {
    const poll = this.polls.find(p => p.id === pollId);
    if (poll) {
      poll.isActive = false;
      poll.closedAt = new Date();
    }
    return poll;
  }

  async getPollResponse(id: string): Promise<PollResponse | undefined> {
    return this.pollResponses.find(r => r.id === id);
  }

  async getPollResponsesByPoll(pollId: string): Promise<PollResponse[]> {
    return this.pollResponses.filter(r => r.pollId === pollId);
  }

  async createPollResponse(insertResponse: InsertPollResponse): Promise<PollResponse> {
    const response: PollResponse = {
      id: randomUUID(),
      pollId: insertResponse.pollId,
      studentId: insertResponse.studentId,
      deviceId: insertResponse.deviceId ?? null,
      selectedOption: insertResponse.selectedOption,
      createdAt: new Date(),
    };
    this.pollResponses.push(response);
    return response;
  }

  async getPollResults(pollId: string): Promise<{ option: number; count: number }[]> {
    const responses = this.pollResponses.filter(r => r.pollId === pollId);
    const counts = new Map<number, number>();
    for (const r of responses) {
      counts.set(r.selectedOption, (counts.get(r.selectedOption) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([option, count]) => ({ option, count }));
  }

  // Subgroups (stubs - not used in memory storage)
  async getSubgroup(id: string): Promise<Subgroup | undefined> {
    return this.subgroups.find(s => s.id === id);
  }

  async getSubgroupsByGroup(groupId: string): Promise<Subgroup[]> {
    return this.subgroups.filter(s => s.groupId === groupId);
  }

  async createSubgroup(insertSubgroup: InsertSubgroup): Promise<Subgroup> {
    const subgroup: Subgroup = {
      id: randomUUID(),
      groupId: insertSubgroup.groupId,
      name: insertSubgroup.name,
      color: insertSubgroup.color ?? null,
      createdAt: new Date(),
    };
    this.subgroups.push(subgroup);
    return subgroup;
  }

  async updateSubgroup(id: string, updates: Partial<InsertSubgroup>): Promise<Subgroup | undefined> {
    const subgroup = this.subgroups.find(s => s.id === id);
    if (subgroup) {
      Object.assign(subgroup, updates);
    }
    return subgroup;
  }

  async deleteSubgroup(id: string): Promise<boolean> {
    const idx = this.subgroups.findIndex(s => s.id === id);
    if (idx >= 0) {
      this.subgroups.splice(idx, 1);
      this.subgroupMembers = this.subgroupMembers.filter(m => m.subgroupId !== id);
      return true;
    }
    return false;
  }

  async getSubgroupMembers(subgroupId: string): Promise<string[]> {
    return this.subgroupMembers.filter(m => m.subgroupId === subgroupId).map(m => m.studentId);
  }

  async addSubgroupMember(subgroupId: string, studentId: string): Promise<SubgroupMember> {
    const member: SubgroupMember = {
      id: randomUUID(),
      subgroupId,
      studentId,
      assignedAt: new Date(),
    };
    this.subgroupMembers.push(member);
    return member;
  }

  async removeSubgroupMember(subgroupId: string, studentId: string): Promise<boolean> {
    const idx = this.subgroupMembers.findIndex(m => m.subgroupId === subgroupId && m.studentId === studentId);
    if (idx >= 0) {
      this.subgroupMembers.splice(idx, 1);
      return true;
    }
    return false;
  }

  async getStudentSubgroups(studentId: string): Promise<string[]> {
    return this.subgroupMembers.filter(m => m.studentId === studentId).map(m => m.subgroupId);
  }

  // Dashboard Tabs (stubs - not used in memory storage)
  async getDashboardTabs(teacherId: string): Promise<DashboardTab[]> {
    return [];
  }

  async getDashboardTab(id: string): Promise<DashboardTab | undefined> {
    return undefined;
  }

  async createDashboardTab(tab: InsertDashboardTab): Promise<DashboardTab> {
    throw new Error("Dashboard tabs not supported in memory storage");
  }

  async updateDashboardTab(id: string, updates: Partial<InsertDashboardTab>): Promise<DashboardTab | undefined> {
    return undefined;
  }

  async deleteDashboardTab(id: string): Promise<boolean> {
    return false;
  }

  // Groups (stubs - not used in memory storage)
  async getGroup(id: string): Promise<Group | undefined> {
    return undefined;
  }

  async getGroupsBySchool(schoolId: string): Promise<Group[]> {
    return [];
  }

  async getGroupsByTeacher(teacherId: string): Promise<Group[]> {
    return [];
  }

  async createGroup(group: InsertGroup): Promise<Group> {
    throw new Error("Groups not supported in memory storage");
  }

  async updateGroup(id: string, updates: Partial<InsertGroup>): Promise<Group | undefined> {
    return undefined;
  }

  async deleteGroup(id: string): Promise<boolean> {
    return false;
  }

  // Group Students (stubs)
  async getGroupStudents(groupId: string): Promise<string[]> {
    return [];
  }

  async assignStudentToGroup(groupId: string, studentId: string): Promise<GroupStudent> {
    throw new Error("Group students not supported in memory storage");
  }

  async unassignStudentFromGroup(groupId: string, studentId: string): Promise<boolean> {
    return false;
  }

  async getStudentGroups(studentId: string): Promise<string[]> {
    return [];
  }

  // Sessions (stubs)
  async getSession(id: string): Promise<Session | undefined> {
    return undefined;
  }

  async getActiveSessionByTeacher(teacherId: string): Promise<Session | undefined> {
    return undefined;
  }

  async getActiveSessions(schoolId: string): Promise<Session[]> {
    return [];
  }

  async getSessionsBySchool(schoolId: string): Promise<Session[]> {
    return [];
  }

  async startSession(session: InsertSession): Promise<Session> {
    throw new Error("Sessions not supported in memory storage");
  }

  async endSession(sessionId: string): Promise<Session | undefined> {
    return undefined;
  }

  // Chat Messages (stubs for MemStorage)
  async createChatMessage(message: InsertChatMessage): Promise<DbChatMessage> {
    throw new Error("Chat messages not supported in memory storage");
  }

  async getStudentMessagesForSchool(schoolId: string, options?: { since?: Date; limit?: number }): Promise<DbChatMessage[]> {
    return [];
  }

  async getChatMessagesBySession(sessionId: string): Promise<DbChatMessage[]> {
    return [];
  }

  async deleteChatMessage(messageId: string): Promise<boolean> {
    return false;
  }

  // Audit Logs (MemStorage stubs)
  async createAuditLog(log: InsertAuditLog): Promise<AuditLog> {
    throw new Error("Audit logs not supported in MemStorage");
  }

  async getAuditLogsBySchool(schoolId: string, options?: {
    action?: string;
    userId?: string;
    since?: Date;
    until?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ logs: AuditLog[]; total: number }> {
    return { logs: [], total: 0 };
  }
}

// Database storage implementation
export class DatabaseStorage implements IStorage {
  private activeStudents: Map<string, string>; // deviceId -> studentId
  private studentStatuses: Map<string, StudentStatus>; // studentId-deviceId -> status

  constructor() {
    this.activeStudents = new Map();
    this.studentStatuses = new Map();
  }

  // Helper to calculate status from lastSeenAt
  // Thresholds designed for 60-second heartbeat intervals:
  // - "online" = last heartbeat within 90s (allows for network delays)
  // - "idle" = last heartbeat within 3 minutes
  // - "offline" = no heartbeat for over 3 minutes
  private calculateStatus(lastSeenAt: number): 'online' | 'idle' | 'offline' {
    const timeSinceLastSeen = Date.now() - lastSeenAt;
    if (timeSinceLastSeen < 90000) return 'online';  // 90 seconds
    if (timeSinceLastSeen < 180000) return 'idle';   // 3 minutes
    return 'offline';
  }

  // Helper to execute function only when deviceId is non-null
  private withDeviceId<T>(deviceId: string | null | undefined, fn: (deviceId: string) => T): T | undefined {
    if (deviceId && deviceId !== null) {
      return fn(deviceId);
    }
    return undefined;
  }

  private async getSchoolNameForSettings(schoolId: string): Promise<string | null> {
    const [school] = await db
      .select({ name: schools.name })
      .from(schools)
      .where(eq(schools.id, schoolId))
      .limit(1);
    return school?.name ?? null;
  }

  // Rehydrate studentStatuses from database on startup
  async rehydrateStatuses(): Promise<void> {
    const allSchools = await this.getAllSchools(true);

    for (const school of allSchools) {
      const allStudents = await this.getStudentsBySchool(school.id);
      const allDevices = await this.getDevicesBySchool(school.id);
      const deviceMap = new Map(allDevices.map(d => [d.deviceId, d]));
      
      for (const student of allStudents) {
        // Skip students without deviceId (email-only students)
        if (!student.deviceId) continue;
        
        const device = deviceMap.get(student.deviceId);
        
        // Get most recent heartbeat for this student to restore actual last seen time
        const recentHeartbeats = await this.getHeartbeatsByStudent(student.id, 1);
        const lastHeartbeat = recentHeartbeats[0];
        
        // Only create status if we have a real heartbeat (no epoch timestamps)
        if (!lastHeartbeat) {
          console.log(`Skipping status creation for student ${student.id} - no heartbeats yet`);
          continue;
        }
        
        const lastSeenAt = new Date(lastHeartbeat.timestamp).getTime();
        const activeTabTitle = lastHeartbeat.activeTabTitle;
        const activeTabUrl = lastHeartbeat.activeTabUrl;
        const favicon = lastHeartbeat.favicon || undefined;
        
        const statusKey = makeStatusKey(student.id, student.deviceId);
        const status: StudentStatus = {
          schoolId: student.schoolId,
          studentId: student.id,
          deviceId: student.deviceId,
          deviceName: device?.deviceName ?? undefined,
          studentName: student.studentName,
          classId: device?.classId || '',
          gradeLevel: student.gradeLevel ?? undefined,
          activeTabTitle: activeTabTitle || "",
          activeTabUrl: activeTabUrl || "",
          favicon,
          lastSeenAt,
          isSharing: false,
          screenLocked: false,
          flightPathActive: false,
          activeFlightPathName: undefined,
          cameraActive: false,
          status: this.calculateStatus(lastSeenAt),
          statusKey,
        };
        this.studentStatuses.set(statusKey, status);
      }
    }
  }

  // Schools
  async getSchool(id: string): Promise<School | undefined> {
    const [school] = await db.select().from(schools).where(eq(schools.id, id));
    return school || undefined;
  }

  async getSchoolByDomain(domain: string): Promise<School | undefined> {
    const [school] = await db.select().from(schools).where(eq(schools.domain, domain));
    return school || undefined;
  }

  async getAllSchools(includeDeleted = false): Promise<School[]> {
    if (includeDeleted) {
      return await db.select().from(schools);
    }
    return await db.select().from(schools).where(isNull(schools.deletedAt));
  }

  async createSchool(insertSchool: InsertSchool): Promise<School> {
    const status = insertSchool.status ?? "trial";
    const planStatus = insertSchool.planStatus ?? "active";
    const planTier = insertSchool.planTier ?? "trial";
    const isActive = insertSchool.isActive ?? status !== "suspended";
    const [school] = await db
      .insert(schools)
      .values({
        ...insertSchool,
        status,
        isActive,
        planStatus,
        planTier,
        schoolSessionVersion: insertSchool.schoolSessionVersion ?? 1,
      })
      .returning();
    return school;
  }

  async updateSchool(id: string, updates: Partial<InsertSchool>): Promise<School | undefined> {
    const [school] = await db
      .update(schools)
      .set(updates)
      .where(eq(schools.id, id))
      .returning();
    return school || undefined;
  }

  async bumpSchoolSessionVersion(schoolId: string): Promise<number> {
    const [school] = await db
      .update(schools)
      .set({ schoolSessionVersion: drizzleSql`${schools.schoolSessionVersion} + 1` })
      .where(eq(schools.id, schoolId))
      .returning();
    return school?.schoolSessionVersion ?? 0;
  }

  async setSchoolActiveState(
    schoolId: string,
    state: { isActive?: boolean; planStatus?: string; disabledReason?: string | null }
  ): Promise<School | undefined> {
    const school = await this.getSchool(schoolId);
    if (!school) return undefined;

    const nextIsActive = state.isActive ?? school.isActive;
    const nextPlanStatus = state.planStatus ?? school.planStatus;
    const isDeactivating =
      (school.isActive && nextIsActive === false)
      || (school.planStatus !== "canceled" && nextPlanStatus === "canceled");
    const isReactivating =
      (!school.isActive && nextIsActive === true)
      || (school.planStatus === "canceled" && nextPlanStatus !== "canceled");

    const updates: Partial<InsertSchool> = {
      isActive: nextIsActive,
      planStatus: nextPlanStatus,
    };

    if (isDeactivating) {
      updates.disabledAt = new Date();
      updates.disabledReason = state.disabledReason ?? school.disabledReason ?? null;
    } else if (isReactivating) {
      updates.disabledAt = null;
      updates.disabledReason = null;
    } else if (state.disabledReason !== undefined) {
      updates.disabledReason = state.disabledReason;
    }

    const updated = await this.updateSchool(schoolId, updates);
    if (updated && (isDeactivating || isReactivating)) {
      await this.bumpSchoolSessionVersion(schoolId);
      return await this.getSchool(schoolId);
    }
    return updated;
  }

  async deleteSchool(id: string): Promise<boolean> {
    const result = await db.delete(schools).where(eq(schools.id, id)).returning();
    return result.length > 0;
  }

  async softDeleteSchool(id: string): Promise<School | undefined> {
    const [school] = await db
      .update(schools)
      .set({ deletedAt: new Date() })
      .where(eq(schools.id, id))
      .returning();
    return school || undefined;
  }

  async restoreSchool(id: string): Promise<School | undefined> {
    const [school] = await db
      .update(schools)
      .set({ deletedAt: null })
      .where(eq(schools.id, id))
      .returning();
    return school || undefined;
  }

  // Users
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    if (!username) return undefined;
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async getUsersBySchool(schoolId: string): Promise<User[]> {
    return await db.select().from(users).where(eq(users.schoolId, schoolId));
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async updateUser(id: string, updates: Partial<InsertUser>): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();
    return user || undefined;
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users);
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.id, id)).returning();
    return result.length > 0;
  }

  async getGoogleOAuthTokens(userId: string): Promise<GoogleOAuthToken | undefined> {
    const [token] = await db.select().from(googleOAuthTokens).where(eq(googleOAuthTokens.userId, userId));
    if (!token) return undefined;
    const refreshToken = isEncryptedSecret(token.refreshToken)
      ? decryptSecret(token.refreshToken)
      : token.refreshToken;
    return { ...token, refreshToken };
  }

  async upsertGoogleOAuthTokens(
    userId: string,
    token: GoogleOAuthTokenUpsert
  ): Promise<GoogleOAuthToken> {
    const [existing] = await db.select().from(googleOAuthTokens).where(eq(googleOAuthTokens.userId, userId));
    const existingRefreshToken = existing?.refreshToken ?? null;
    const hasEncryptedToken = isEncryptedSecret(existingRefreshToken);
    const providedRefreshToken = token.refreshToken ?? undefined;
    const refreshTokenToStore = providedRefreshToken
      ? encryptSecret(providedRefreshToken)
      : existingRefreshToken
        ? (hasEncryptedToken ? existingRefreshToken : encryptSecret(existingRefreshToken))
        : null;
    const expiryDate = normalizeExpiryDate(token.expiryDate);

    if (!refreshTokenToStore) {
      throw new Error("Refresh token is required to store Google OAuth credentials.");
    }

    const updateSet: GoogleOAuthTokenUpdateSet = {
      scope: token.scope ?? undefined,
      tokenType: token.tokenType ?? undefined,
      expiryDate,
      updatedAt: new Date(),
    };

    if (providedRefreshToken || (existingRefreshToken && !hasEncryptedToken)) {
      updateSet.refreshToken = refreshTokenToStore;
    }

    const [saved] = await db
      .insert(googleOAuthTokens)
      .values({
        userId,
        refreshToken: refreshTokenToStore,
        scope: token.scope ?? undefined,
        tokenType: token.tokenType ?? undefined,
        expiryDate,
      })
      .onConflictDoUpdate({
        target: googleOAuthTokens.userId,
        set: updateSet,
      })
      .returning();
    const refreshToken = isEncryptedSecret(saved.refreshToken)
      ? decryptSecret(saved.refreshToken)
      : saved.refreshToken;
    return { ...saved, refreshToken };
  }

  // Devices
  async getDevice(deviceId: string): Promise<Device | undefined> {
    const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId));
    return device || undefined;
  }

  async getDevicesBySchool(schoolId: string): Promise<Device[]> {
    return await db.select().from(devices).where(eq(devices.schoolId, schoolId));
  }

  async registerDevice(insertDevice: InsertDevice): Promise<Device> {
    // Upsert device (insert or update if exists)
    const [device] = await db
      .insert(devices)
      .values(insertDevice)
      .onConflictDoUpdate({
        target: devices.deviceId,
        set: {
          deviceName: insertDevice.deviceName,
          schoolId: insertDevice.schoolId,
          classId: insertDevice.classId,
        },
      })
      .returning();
    
    return device;
  }

  async updateDevice(deviceId: string, updates: Partial<Omit<InsertDevice, 'deviceId'>>): Promise<Device | undefined> {
    const [device] = await db
      .update(devices)
      .set(updates)
      .where(eq(devices.deviceId, deviceId))
      .returning();
    
    if (!device) return undefined;
    
    // Update statuses for all students on this device (using composite keys)
    const studentsOnDevice = await this.getStudentsByDevice(device.schoolId, deviceId);
    for (const student of studentsOnDevice) {
      const statusKey = makeStatusKey(student.id, deviceId);
      const status = this.studentStatuses.get(statusKey);
      if (status) {
        if (updates.deviceName !== undefined) {
          status.deviceName = updates.deviceName ?? undefined;
        }
        if (updates.classId !== undefined) {
          status.classId = updates.classId;
        }
        this.studentStatuses.set(statusKey, status);
      }
    }
    
    return device;
  }

  async deleteDevice(deviceId: string): Promise<boolean> {
    // Get all students on this device
    const existingDevice = await this.getDevice(deviceId);
    if (!existingDevice) {
      return false;
    }
    const studentsOnDevice = await this.getStudentsByDevice(existingDevice.schoolId, deviceId);
    const studentIds = studentsOnDevice.map(s => s.id);
    
    // Delete heartbeats for this device
    await db.delete(heartbeats).where(eq(heartbeats.deviceId, deviceId));
    
    // Delete events for this device
    await db.delete(events).where(eq(events.deviceId, deviceId));
    
    // Delete all students on this device
    if (studentIds.length > 0) {
      await db.delete(students).where(inArray(students.id, studentIds));
      await db
        .update(schools)
        .set({ usedLicenses: drizzleSql`GREATEST(${schools.usedLicenses} - ${studentIds.length}, 0)` })
        .where(eq(schools.id, existingDevice.schoolId));
      
      // Remove from in-memory status maps using composite keys
      for (const student of studentsOnDevice) {
        const statusKey = makeStatusKey(student.id, deviceId);
        this.studentStatuses.delete(statusKey);
      }
    }
    
    // Clear active student mapping
    this.activeStudents.delete(deviceId);
    
    // Delete device
    const [deletedDevice] = await db
      .delete(devices)
      .where(eq(devices.deviceId, deviceId))
      .returning();
    
    return !!deletedDevice;
  }

  // Students
  async getStudent(studentId: string): Promise<Student | undefined> {
    const [student] = await db.select().from(students).where(eq(students.id, studentId));
    return student || undefined;
  }

  async getStudentByEmail(email: string): Promise<Student | undefined> {
    const [student] = await db.select().from(students).where(eq(students.studentEmail, email));
    return student || undefined;
  }

  async getStudentBySchoolEmail(schoolId: string, emailLc: string): Promise<Student | undefined> {
    const [student] = await db
      .select()
      .from(students)
      .where(drizzleSql`${students.schoolId} = ${schoolId} AND ${students.emailLc} = ${emailLc}`);
    return student || undefined;
  }

  async getStudentBySchoolGoogleUserId(schoolId: string, googleUserId: string): Promise<Student | undefined> {
    const [student] = await db
      .select()
      .from(students)
      .where(drizzleSql`${students.schoolId} = ${schoolId} AND ${students.googleUserId} = ${googleUserId}`);
    return student || undefined;
  }

  async getStudentsByDevice(schoolId: string, deviceId: string): Promise<Student[]> {
    return await db
      .select()
      .from(students)
      .where(drizzleSql`${students.schoolId} = ${schoolId} AND ${students.deviceId} = ${deviceId}`);
  }

  async getStudentsBySchool(schoolId: string): Promise<Student[]> {
    return await db.select().from(students).where(eq(students.schoolId, schoolId));
  }

  async createStudent(insertStudent: InsertStudent): Promise<Student> {
    const student = await db.transaction(async (tx) => {
      const [school] = await tx
        .select({ maxLicenses: schools.maxLicenses, usedLicenses: schools.usedLicenses })
        .from(schools)
        .where(eq(schools.id, insertStudent.schoolId));

      const maxLicenses = school?.maxLicenses ?? 0;
      const currentCount = school?.usedLicenses ?? 0;

      if (maxLicenses > 0) {
        const reservation = await tx
          .update(schools)
          .set({ usedLicenses: drizzleSql`${schools.usedLicenses} + 1` })
          .where(drizzleSql`${schools.id} = ${insertStudent.schoolId} AND ${schools.maxLicenses} > 0 AND ${schools.usedLicenses} < ${schools.maxLicenses}`)
          .returning({ usedLicenses: schools.usedLicenses, maxLicenses: schools.maxLicenses });

        if (!reservation[0]) {
          const [latestSchool] = await tx
            .select({ maxLicenses: schools.maxLicenses, usedLicenses: schools.usedLicenses })
            .from(schools)
            .where(eq(schools.id, insertStudent.schoolId));

          const error = new Error("LICENSE_LIMIT_REACHED");
          (error as Error & { code: string; maxLicenses: number; currentCount: number }).code = "LICENSE_LIMIT_REACHED";
          (error as Error & { maxLicenses: number }).maxLicenses = latestSchool?.maxLicenses ?? maxLicenses;
          (error as Error & { currentCount: number }).currentCount = latestSchool?.usedLicenses ?? currentCount;
          throw error;
        }
      } else if (school) {
        await tx
          .update(schools)
          .set({ usedLicenses: drizzleSql`${schools.usedLicenses} + 1` })
          .where(eq(schools.id, insertStudent.schoolId));
      }

      const [createdStudent] = await tx
        .insert(students)
        .values(insertStudent)
        .returning();

      return createdStudent;
    });
    
    // Get device info for this student (only if deviceId exists)
    const device = student.deviceId ? await this.getDevice(student.deviceId) : undefined;
    
    // Get most recent heartbeat to initialize status with real data
    const recentHeartbeats = await this.getHeartbeatsByStudent(student.id, 1);
    const lastHeartbeat = recentHeartbeats[0];
    
    // Only initialize status if we have a real heartbeat (no epoch timestamps)
    if (lastHeartbeat && student.deviceId) {
      const lastSeenAt = new Date(lastHeartbeat.timestamp).getTime();
      const activeTabTitle = lastHeartbeat.activeTabTitle;
      const activeTabUrl = lastHeartbeat.activeTabUrl;
      const favicon = lastHeartbeat.favicon || undefined;
      
      const statusKey = makeStatusKey(student.id, student.deviceId);
      const status: StudentStatus = {
        schoolId: student.schoolId,
        studentId: student.id,
        deviceId: student.deviceId,
        deviceName: device?.deviceName ?? undefined,
        studentName: student.studentName,
        classId: device?.classId || '',
        gradeLevel: student.gradeLevel ?? undefined,
        activeTabTitle: activeTabTitle || "",
        activeTabUrl: activeTabUrl || "",
        favicon,
        lastSeenAt,
        isSharing: false,
        screenLocked: false,
        flightPathActive: false,
        activeFlightPathName: undefined,
        cameraActive: false,
        status: this.calculateStatus(lastSeenAt),
        statusKey,
      };
      this.studentStatuses.set(statusKey, status);
    } else {
      console.log(`Skipping status creation for new student ${student.id} - will be created on first heartbeat`);
    }
    
    return student;
  }

  async updateStudent(studentId: string, updates: Partial<InsertStudent>): Promise<Student | undefined> {
    // Get student before update to know old deviceId
    const oldStudent = await this.getStudent(studentId);
    if (!oldStudent) return undefined;
    
    const [student] = await db
      .update(students)
      .set(updates)
      .where(eq(students.id, studentId))
      .returning();
    
    if (!student) return undefined;
    
    // If deviceId changed, we need to move the status to a new key
    if (updates.deviceId !== undefined && oldStudent.deviceId !== student.deviceId) {
      const oldKey = makeStatusKey(studentId, oldStudent.deviceId);
      const status = this.studentStatuses.get(oldKey);
      
      if (status) {
        // Delete old key
        this.studentStatuses.delete(oldKey);
        
        // Update deviceId and related fields
        status.deviceId = student.deviceId;
        if (student.deviceId) {
          const device = await this.getDevice(student.deviceId);
          if (device) {
            status.deviceName = device.deviceName ?? undefined;
            status.classId = device.classId;
          }
        } else {
          status.deviceName = undefined;
          status.classId = '';
        }
        
        // Update other fields
        status.schoolId = student.schoolId;
        if (updates.studentName) {
          status.studentName = updates.studentName;
        }
        if (updates.gradeLevel !== undefined) {
          status.gradeLevel = updates.gradeLevel ?? undefined;
        }
        
        // Set with new key
        const newKey = makeStatusKey(studentId, student.deviceId);
        status.statusKey = newKey;
        this.studentStatuses.set(newKey, status);
      }
    } else {
      // DeviceId didn't change, just update fields
      const statusKey = makeStatusKey(studentId, student.deviceId);
      const status = this.studentStatuses.get(statusKey);
      if (status) {
        if (updates.studentName) {
          status.studentName = updates.studentName;
        }
        if (updates.gradeLevel !== undefined) {
          status.gradeLevel = updates.gradeLevel ?? undefined;
        }
        this.studentStatuses.set(statusKey, status);
      }
    }
    
    return student;
  }

  async deleteStudent(studentId: string): Promise<boolean> {
    // Delete teacher-student assignments
    await db.delete(teacherStudents).where(eq(teacherStudents.studentId, studentId));
    
    // Delete group-student assignments (remove from all classes)
    await db.delete(groupStudents).where(eq(groupStudents.studentId, studentId));
    
    // Delete heartbeats for this student
    await db.delete(heartbeats).where(eq(heartbeats.studentId, studentId));
    
    // Delete events for this student
    await db.delete(events).where(eq(events.studentId, studentId));
    
    // Delete check-ins for this student
    await db.delete(checkIns).where(eq(checkIns.studentId, studentId));
    
    // Get student to find device for active student cleanup
    const student = await this.getStudent(studentId);
    
    // Delete student
    const [deletedStudent] = await db
      .delete(students)
      .where(eq(students.id, studentId))
      .returning();

    if (deletedStudent) {
      await db
        .update(schools)
        .set({ usedLicenses: drizzleSql`GREATEST(${schools.usedLicenses} - 1, 0)` })
        .where(eq(schools.id, deletedStudent.schoolId));
    }
    
    // Remove from in-memory status map using composite key
    if (student) {
      const statusKey = makeStatusKey(studentId, student.deviceId);
      this.studentStatuses.delete(statusKey);
    }
    
    // Clear from active students if this student is active
    if (student) {
      this.withDeviceId(student.deviceId, (deviceId) => {
        const activeStudentId = this.activeStudents.get(deviceId);
        if (activeStudentId === studentId) {
          this.activeStudents.delete(deviceId);
        }
      });
    }
    
    return !!deletedStudent;
  }

  async upsertStudentDevice(studentId: string, deviceId: string): Promise<void> {
    // Track student-device relationship in student_devices table
    // Insert or update lastSeenAt if already exists
    await db
      .insert(studentDevices)
      .values({
        studentId,
        deviceId,
      })
      .onConflictDoUpdate({
        target: [studentDevices.studentId, studentDevices.deviceId],
        set: {
          lastSeenAt: drizzleSql`now()`,
        },
      });
  }

  async upsertClassroomCourse(course: InsertClassroomCourse): Promise<ClassroomCourse> {
    const [saved] = await db
      .insert(classroomCourses)
      .values(course)
      .onConflictDoUpdate({
        target: [classroomCourses.schoolId, classroomCourses.courseId],
        set: {
          name: course.name,
          section: course.section ?? null,
          room: course.room ?? null,
          descriptionHeading: course.descriptionHeading ?? null,
          ownerId: course.ownerId ?? null,
          lastSyncedAt: course.lastSyncedAt ?? drizzleSql`now()`,
        },
      })
      .returning();
    return saved;
  }

  async getClassroomCourse(schoolId: string, courseId: string): Promise<ClassroomCourse | undefined> {
    const [course] = await db
      .select()
      .from(classroomCourses)
      .where(drizzleSql`${classroomCourses.schoolId} = ${schoolId} AND ${classroomCourses.courseId} = ${courseId}`)
      .limit(1);
    return course;
  }

  async getClassroomCoursesForSchool(schoolId: string): Promise<ClassroomCourse[]> {
    return await db
      .select()
      .from(classroomCourses)
      .where(eq(classroomCourses.schoolId, schoolId))
      .orderBy(classroomCourses.name);
  }

  async getClassroomCourseStudentCount(schoolId: string, courseId: string): Promise<number> {
    const result = await db
      .select({ count: drizzleSql<number>`count(*)` })
      .from(classroomCourseStudents)
      .where(drizzleSql`${classroomCourseStudents.schoolId} = ${schoolId} AND ${classroomCourseStudents.courseId} = ${courseId}`);
    return result[0]?.count || 0;
  }

  async getClassroomCourseStudentIds(schoolId: string, courseId: string): Promise<string[]> {
    const rows = await db
      .select({ studentId: classroomCourseStudents.studentId })
      .from(classroomCourseStudents)
      .where(drizzleSql`${classroomCourseStudents.schoolId} = ${schoolId} AND ${classroomCourseStudents.courseId} = ${courseId}`);
    return rows.map((row: { studentId: string }) => row.studentId);
  }

  async replaceCourseStudents(
    schoolId: string,
    courseId: string,
    studentIdsWithMeta: Array<Pick<InsertClassroomCourseStudent, "studentId" | "googleUserId" | "studentEmailLc">>
  ): Promise<number> {
    await db
      .delete(classroomCourseStudents)
      .where(drizzleSql`${classroomCourseStudents.schoolId} = ${schoolId} AND ${classroomCourseStudents.courseId} = ${courseId}`);

    if (studentIdsWithMeta.length === 0) {
      return 0;
    }

    const rows = studentIdsWithMeta.map((entry) => ({
      schoolId,
      courseId,
      studentId: entry.studentId,
      googleUserId: entry.googleUserId ?? null,
      studentEmailLc: entry.studentEmailLc ?? null,
      lastSeenAt: new Date(),
    }));

    const inserted = await db
      .insert(classroomCourseStudents)
      .values(rows)
      .returning({ id: classroomCourseStudents.id });
    return inserted.length;
  }

  // Student Sessions - INDUSTRY STANDARD SESSION-BASED TRACKING (PostgreSQL)
  async findActiveStudentSession(studentId: string): Promise<StudentSession | undefined> {
    const [session] = await db
      .select()
      .from(studentSessions)
      .where(drizzleSql`${studentSessions.studentId} = ${studentId} AND ${studentSessions.isActive} = true`)
      .limit(1);
    return session;
  }

  async findActiveStudentSessionByDevice(deviceId: string): Promise<StudentSession | undefined> {
    const [session] = await db
      .select()
      .from(studentSessions)
      .where(drizzleSql`${studentSessions.deviceId} = ${deviceId} AND ${studentSessions.isActive} = true`)
      .limit(1);
    return session;
  }

  async startStudentSession(studentId: string, deviceId: string): Promise<StudentSession> {
    // INDUSTRY STANDARD SWAP LOGIC: Enforce one active session per student/device
    // Uses database constraints + transactional logic to prevent race conditions
    
    // 1. Check if student already has an active session
    const existingStudentSession = await this.findActiveStudentSession(studentId);
    
    // 2. If student active on SAME device, just update heartbeat (no-op, return existing)
    if (existingStudentSession && existingStudentSession.deviceId === deviceId) {
      await this.updateStudentSessionHeartbeat(existingStudentSession.id, new Date());
      return existingStudentSession;
    }
    
    // 3. If student active on DIFFERENT device, end old session (student switched devices)
    if (existingStudentSession && existingStudentSession.deviceId !== deviceId) {
      await this.endStudentSession(existingStudentSession.id);
    }
    
    // 4. Check if device already has an active session (another student logged in)
    const existingDeviceSession = await this.findActiveStudentSessionByDevice(deviceId);
    
    // 5. If different student on this device, end their session (device eviction)
    if (existingDeviceSession && existingDeviceSession.studentId !== studentId) {
      await this.endStudentSession(existingDeviceSession.id);
    }
    
    // 6. Create new active session (DB unique constraints ensure no duplicates)
    const [session] = await db
      .insert(studentSessions)
      .values({ studentId, deviceId })
      .returning();
    return session;
  }

  async endStudentSession(sessionId: string): Promise<void> {
    // Get session details before ending it (for status map sync)
    const [session] = await db
      .select()
      .from(studentSessions)
      .where(eq(studentSessions.id, sessionId))
      .limit(1);
    
    // Mark session as ended
    await db
      .update(studentSessions)
      .set({ isActive: false, endedAt: drizzleSql`now()` })
      .where(eq(studentSessions.id, sessionId));
    
    // Sync in-memory status map to mark student offline (defensive guard for null deviceId)
    if (session && session.deviceId) {
      const statusKey = makeStatusKey(session.studentId, session.deviceId);
      const status = this.studentStatuses.get(statusKey);
      if (status) {
        status.lastSeenAt = 0; // Force status to 'offline'
        this.studentStatuses.set(statusKey, status);
      }
    }
  }

  async updateStudentSessionHeartbeat(sessionId: string, lastSeenAt: Date): Promise<void> {
    await db
      .update(studentSessions)
      .set({ lastSeenAt })
      .where(eq(studentSessions.id, sessionId));
  }

  async expireStaleStudentSessions(maxAgeSeconds: number): Promise<number> {
    const cutoffTime = new Date(Date.now() - maxAgeSeconds * 1000);
    const result = await db
      .update(studentSessions)
      .set({ isActive: false, endedAt: drizzleSql`now()` })
      .where(drizzleSql`${studentSessions.isActive} = true AND ${studentSessions.lastSeenAt} < ${cutoffTime.toISOString()}`)
      .returning({ 
        id: studentSessions.id, 
        studentId: studentSessions.studentId,
        deviceId: studentSessions.deviceId,
      });
    
    // Also update in-memory status map to mark expired students as offline
    // CRITICAL: Use composite key makeStatusKey(studentId, deviceId) for lookup
    // Defensive guard: Skip entries with null/undefined deviceId to prevent orphaned status entries
    for (const session of result) {
      if (session.deviceId) {
        const statusKey = makeStatusKey(session.studentId, session.deviceId);
        const status = this.studentStatuses.get(statusKey);
        if (status) {
          status.lastSeenAt = 0; // Force status to 'offline'
          this.studentStatuses.set(statusKey, status);
        }
      }
    }
    
    return result.length;
  }

  // Student Status (in-memory tracking)
  async getStudentStatus(studentId: string): Promise<StudentStatus | undefined> {
    const status = this.studentStatuses.get(studentId);
    if (!status) return undefined;
    
    return {
      ...status,
      status: this.calculateStatus(status.lastSeenAt),
    };
  }

  async getStudentStatusesBySchool(schoolId: string): Promise<StudentStatus[]> {
    const statuses = Array.from(this.studentStatuses.values()).filter((status) => {
      if (!status.schoolId) return false;
      return status.schoolId === schoolId;
    });
    
    return statuses.map(status => ({
      ...status,
      status: this.calculateStatus(status.lastSeenAt),
    }));
  }

  async getStudentStatusesAggregatedBySchool(schoolId: string): Promise<AggregatedStudentStatus[]> {
    const allStatuses = await this.getStudentStatusesBySchool(schoolId);
    
    // Group statuses by studentId
    const statusesByStudent = new Map<string, StudentStatus[]>();
    for (const status of allStatuses) {
      const existing = statusesByStudent.get(status.studentId) || [];
      existing.push(status);
      statusesByStudent.set(status.studentId, existing);
    }
    
    // Aggregate each student's devices
    const aggregated: AggregatedStudentStatus[] = [];
    for (const [studentId, deviceStatuses] of Array.from(statusesByStudent.entries())) {
      // Find most recent device (primary device)
      const primaryStatus = deviceStatuses.reduce((latest: StudentStatus, current: StudentStatus) => 
        current.lastSeenAt > latest.lastSeenAt ? current : latest
      );
      
      // Determine best status across all devices (Online > Idle > Offline)
      const statusPriority: Record<string, number> = { online: 3, idle: 2, offline: 1 };
      const bestStatus = deviceStatuses.reduce((best: StudentStatus, current: StudentStatus) => 
        statusPriority[current.status] > statusPriority[best.status] ? current : best
      );
      
      // Get student email from student record
      const student = await this.getStudent(studentId);
      
      aggregated.push({
        studentId,
        studentEmail: student?.studentEmail || undefined,
        studentName: primaryStatus.studentName,
        gradeLevel: primaryStatus.gradeLevel,
        classId: primaryStatus.classId,
        
        // Multi-device info
        deviceCount: deviceStatuses.length,
        devices: deviceStatuses.map((s: StudentStatus) => ({
          deviceId: s.deviceId,
          deviceName: s.deviceName,
          status: s.status,
          lastSeenAt: s.lastSeenAt,
        })),
        
        // Aggregated status
        status: bestStatus.status,
        lastSeenAt: Math.max(...deviceStatuses.map((s: StudentStatus) => s.lastSeenAt)),
        
        // Primary device data (most recent)
        primaryDeviceId: primaryStatus.deviceId,
        deviceName: primaryStatus.deviceName, // Device name from primary device
        activeTabTitle: primaryStatus.activeTabTitle,
        activeTabUrl: primaryStatus.activeTabUrl,
        favicon: primaryStatus.favicon,
        // Merge allOpenTabs from ALL devices (include deviceId, skip devices without valid ID)
        allOpenTabs: (() => {
          const mergedTabs: Array<TabInfo & {deviceId: string}> = [];
          deviceStatuses.forEach(deviceStatus => {
            // Only include tabs from devices with valid (non-empty) deviceId
            if (!deviceStatus.deviceId || deviceStatus.deviceId.trim() === '') {
              console.warn(`⚠️ Skipping tabs for student ${studentId} - device has no valid ID`);
              return;
            }
            deviceStatus.allOpenTabs?.forEach(tab => {
              mergedTabs.push({ ...tab, deviceId: deviceStatus.deviceId! }); // deviceId guaranteed non-empty here
            });
          });
          return mergedTabs.length > 0 ? mergedTabs : undefined;
        })(),
        isSharing: primaryStatus.isSharing,
        screenLocked: primaryStatus.screenLocked,
        flightPathActive: primaryStatus.flightPathActive,
        activeFlightPathName: primaryStatus.activeFlightPathName,
        cameraActive: primaryStatus.cameraActive,
        currentUrlDuration: primaryStatus.currentUrlDuration,
        viewMode: primaryStatus.viewMode,
      });
    }
    
    return aggregated;
  }

  async updateStudentStatus(status: StudentStatus): Promise<void> {
    const statusKey = makeStatusKey(status.studentId, status.deviceId);
    this.studentStatuses.set(statusKey, status);
  }

  async getActiveStudentForDevice(deviceId: string): Promise<Student | undefined> {
    const activeStudentId = this.activeStudents.get(deviceId);
    if (!activeStudentId) return undefined;
    return await this.getStudent(activeStudentId);
  }

  async setActiveStudentForDevice(deviceId: string, studentId: string | null): Promise<void> {
    if (studentId === null) {
      this.activeStudents.delete(deviceId);
    } else {
      this.activeStudents.set(deviceId, studentId);
    }
  }

  // Heartbeats
  async addHeartbeat(insertHeartbeat: InsertHeartbeat, allOpenTabs?: TabInfo[]): Promise<Heartbeat> {
    const [heartbeat] = await db
      .insert(heartbeats)
      .values(insertHeartbeat)
      .returning();
    
    // Map deviceId to the correct roster studentId (critical for matching extension-sent IDs to database IDs)
    let canonicalStudentId = heartbeat.studentId;
    
    // First try: Check if there's an active student mapped to this device
    const activeStudent = await this.getActiveStudentForDevice(heartbeat.deviceId);
    if (activeStudent) {
      canonicalStudentId = activeStudent.id;
      console.log('Mapped device to canonical studentId:', canonicalStudentId);
    } else if (heartbeat.studentId) {
      // Second try: Check if the heartbeat's studentId exists in database
      const studentExists = await this.getStudent(heartbeat.studentId);
      if (studentExists) {
        canonicalStudentId = heartbeat.studentId;
      } else {
        console.warn('No active student mapping found for heartbeat studentId');
        canonicalStudentId = null;
      }
    } else if (heartbeat.studentEmail && heartbeat.schoolId) {
      // Third try: Look up student by email (EMAIL-FIRST FLOW)
      // Use the schoolId from the heartbeat (don't override with settings)
      console.log('🔍 [addHeartbeat] Looking up student by email');
      const studentByEmail = await this.getStudentBySchoolEmail(heartbeat.schoolId, normalizeEmail(heartbeat.studentEmail));
      if (studentByEmail) {
        canonicalStudentId = studentByEmail.id;
        console.log('🔍 [addHeartbeat] Found student by email:', studentByEmail.id, 'name:', studentByEmail.studentName);
        // Update active student mapping for future heartbeats
        await this.setActiveStudentForDevice(heartbeat.deviceId, studentByEmail.id);
      } else {
        console.warn('⚠️ [addHeartbeat] No student found for email');
        canonicalStudentId = null;
      }
    }
    
    // Update student status if we have a valid studentId
    if (canonicalStudentId) {
      // Use composite key: studentId-deviceId (allows same student on multiple devices)
      const statusKey = makeStatusKey(canonicalStudentId, heartbeat.deviceId);
      let status = this.studentStatuses.get(statusKey);
      if (!status) {
        // Status missing (e.g., after restart), get student info and create
        const student = await this.getStudent(canonicalStudentId);
        if (student) {
          const device = await this.getDevice(heartbeat.deviceId);
          status = {
            schoolId: heartbeat.schoolId ?? student.schoolId ?? undefined,
            studentId: student.id,
            deviceId: heartbeat.deviceId, // Use heartbeat's deviceId (current device)
            deviceName: device?.deviceName ?? undefined,
            studentName: student.studentName,
            classId: device?.classId || '',
            gradeLevel: student.gradeLevel ?? undefined,
            activeTabTitle: heartbeat.activeTabTitle || "",
            activeTabUrl: heartbeat.activeTabUrl || "",
            favicon: heartbeat.favicon ?? undefined,
            allOpenTabs, // 🆕 All tabs (in-memory only)
            lastSeenAt: Date.now(),
            isSharing: heartbeat.isSharing ?? false,
            screenLocked: heartbeat.screenLocked ?? false,
            flightPathActive: heartbeat.flightPathActive ?? false,
            activeFlightPathName: heartbeat.activeFlightPathName || undefined,
            cameraActive: heartbeat.cameraActive ?? false,
            status: 'online',
            statusKey, // Store composite key for reference
          };
          this.studentStatuses.set(statusKey, status);
          console.log('Created StudentStatus from DB for student:', student.id);
        } else {
          console.warn('Heartbeat has canonicalStudentId but student not found in DB:', canonicalStudentId);
        }
      } else {
        // Update existing status
        const now = Date.now();
        if (heartbeat.schoolId) {
          status.schoolId = heartbeat.schoolId;
        }
        status.activeTabTitle = heartbeat.activeTabTitle || "";
        status.activeTabUrl = heartbeat.activeTabUrl || "";
        status.favicon = heartbeat.favicon ?? undefined;
        status.allOpenTabs = allOpenTabs; // 🆕 Update all tabs (in-memory only)
        
        // Only update screenLocked/flightPath from heartbeat if server hasn't set it recently (within 15 seconds)
        // This prevents heartbeat race conditions where the extension hasn't yet processed the server command
        // 15 seconds covers the worst-case heartbeat interval plus network delays
        const serverSetRecently = status.screenLockedSetAt && (now - status.screenLockedSetAt) < 15000;
        if (!serverSetRecently) {
          status.screenLocked = heartbeat.screenLocked ?? false;
          status.flightPathActive = heartbeat.flightPathActive ?? false;
          status.activeFlightPathName = heartbeat.activeFlightPathName || undefined;
        }

        status.isSharing = heartbeat.isSharing ?? false;
        status.cameraActive = heartbeat.cameraActive ?? false;
        status.lastSeenAt = now;
        status.status = this.calculateStatus(now);
        console.log('Updated StudentStatus lastSeenAt:', { studentId: canonicalStudentId, lastSeenAt: now });
        
        // Calculate current URL duration
        status.currentUrlDuration = await this.calculateCurrentUrlDurationDb(canonicalStudentId, heartbeat.activeTabUrl);
        
        this.studentStatuses.set(statusKey, status);
      }
    }
    
    return heartbeat;
  }

  // Helper function to calculate duration on current URL (DatabaseStorage)
  // @param studentId - The canonical student ID (handles email-first students)
  private async calculateCurrentUrlDurationDb(studentId: string, currentUrl: string | null): Promise<number> {
    // Handle null URL
    if (!currentUrl) {
      return 0;
    }
    
    // Get recent heartbeats for this student
    const studentHeartbeats = await db
      .select()
      .from(heartbeats)
      .where(eq(heartbeats.studentId, studentId))
      .orderBy(heartbeats.timestamp);
    
    if (studentHeartbeats.length === 0) {
      return 10; // First heartbeat, default to 10 seconds
    }
    
    // Find consecutive heartbeats with the same URL (going backwards from most recent)
    let consecutiveCount = 0;
    let startTime: Date | null = null;
    let endTime: Date | null = null;
    
    for (let i = studentHeartbeats.length - 1; i >= 0; i--) {
      const hb = studentHeartbeats[i];
      if (hb.activeTabUrl === currentUrl) {
        consecutiveCount++;
        endTime = endTime || new Date(hb.timestamp);
        startTime = new Date(hb.timestamp);
      } else {
        break; // Stop when URL changes
      }
    }
    
    if (consecutiveCount === 0 || !startTime || !endTime) {
      return 10; // Default to 10 seconds
    }
    
    // Calculate duration: time span + one heartbeat interval (10s)
    const timeSpanSeconds = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);
    return timeSpanSeconds + 10;
  }

  async getHeartbeatsByDevice(deviceId: string, limit: number = 1000): Promise<Heartbeat[]> {
    return await db
      .select()
      .from(heartbeats)
      .where(eq(heartbeats.deviceId, deviceId))
      .orderBy(desc(heartbeats.timestamp))
      .limit(limit);
  }

  async getHeartbeatsByStudent(studentId: string, limit: number = 1000): Promise<Heartbeat[]> {
    return await db
      .select()
      .from(heartbeats)
      .where(eq(heartbeats.studentId, studentId))
      .orderBy(desc(heartbeats.timestamp))
      .limit(limit);
  }

  async getHeartbeatsBySchool(schoolId: string): Promise<Heartbeat[]> {
    return await db
      .select()
      .from(heartbeats)
      .where(eq(heartbeats.schoolId, schoolId))
      .orderBy(desc(heartbeats.timestamp));
  }

  async cleanupOldHeartbeats(retentionHours: number): Promise<number> {
    const cutoffTime = new Date(Date.now() - retentionHours * 60 * 60 * 1000);
    
    const deleted = await db
      .delete(heartbeats)
      .where(lt(heartbeats.timestamp, cutoffTime))
      .returning();
    
    return deleted.length;
  }

  // Events
  async addEvent(insertEvent: InsertEvent): Promise<Event> {
    const [event] = await db
      .insert(events)
      .values(insertEvent)
      .returning();
    return event;
  }

  async getEventsByDevice(deviceId: string): Promise<Event[]> {
    return await db
      .select()
      .from(events)
      .where(eq(events.deviceId, deviceId))
      .orderBy(desc(events.timestamp));
  }

  async getEventsByStudent(studentId: string): Promise<Event[]> {
    return await db
      .select()
      .from(events)
      .where(eq(events.studentId, studentId))
      .orderBy(desc(events.timestamp));
  }

  // Rosters
  async getRoster(classId: string): Promise<Roster | undefined> {
    const [roster] = await db.select().from(rosters).where(eq(rosters.classId, classId));
    return roster || undefined;
  }

  async getRostersBySchool(schoolId: string): Promise<Roster[]> {
    const schoolDevices = await db
      .select({ deviceId: devices.deviceId })
      .from(devices)
      .where(eq(devices.schoolId, schoolId));
    const schoolDeviceIds = new Set(schoolDevices.map((device: { deviceId: string }) => device.deviceId));
    const allRosters = await db.select().from(rosters);
    return allRosters.filter((roster: Roster) =>
      roster.deviceIds.some((deviceId: string) => schoolDeviceIds.has(deviceId))
    );
  }

  async upsertRoster(insertRoster: InsertRoster): Promise<Roster> {
    const existing = await this.getRoster(insertRoster.classId);
    
    if (existing) {
      const [updated] = await db
        .update(rosters)
        .set({ ...insertRoster, uploadedAt: new Date() })
        .where(eq(rosters.classId, insertRoster.classId))
        .returning();
      return updated;
    } else {
      const [created] = await db
        .insert(rosters)
        .values(insertRoster)
        .returning();
      return created;
    }
  }

  // Settings
  async getSettingsBySchoolId(schoolId: string): Promise<Settings | null> {
    const [setting] = await db
      .select()
      .from(settings)
      .where(eq(settings.schoolId, schoolId))
      .limit(1);
    return setting || null;
  }

  async ensureSettingsForSchool(schoolId: string): Promise<Settings> {
    const existing = await this.getSettingsBySchoolId(schoolId);
    if (existing) {
      return existing;
    }
    const schoolName = await this.getSchoolNameForSettings(schoolId);
    const defaults = buildDefaultSettingsInput({ schoolId, schoolName });
    const insertValues: typeof settings.$inferInsert = normalizeSettings(defaults);
    const [created] = await db
      .insert(settings)
      .values(insertValues)
      .onConflictDoNothing()
      .returning();
    if (created) {
      return created;
    }
    const fallback = await this.getSettingsBySchoolId(schoolId);
    if (!fallback) {
      throw new Error(`Failed to ensure settings for schoolId=${schoolId}`);
    }
    return fallback;
  }

  async upsertSettingsForSchool(schoolId: string, input: SettingsUpsertInput): Promise<Settings> {
    const existing = await this.getSettingsBySchoolId(schoolId);
    const sanitizedInput = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined)
    ) as SettingsUpsertInput;
    const schoolName = sanitizedInput.schoolName ?? await this.getSchoolNameForSettings(schoolId);
    const defaults = buildDefaultSettingsInput({
      schoolId,
      schoolName,
      wsSharedKey: sanitizedInput.wsSharedKey,
    });
    const { schoolId: _ignoredSchoolId, ...updateInput } = sanitizedInput;
    const updateSet = insertSettingsSchema.partial().parse(
      Object.fromEntries(Object.entries(updateInput).filter(([, value]) => value !== undefined))
    );
    const parsed = insertSettingsSchema.parse({
      ...defaults,
      ...sanitizedInput,
      schoolId,
    });
    const insertValues = normalizeSettingsForInsert({
      id: existing?.id ?? randomUUID(),
      ...parsed,
    });
    const [result] = await db
      .insert(settings)
      .values(insertValues)
      .onConflictDoUpdate({
        target: settings.schoolId,
        set: normalizeSettings(updateSet) as typeof settings.$inferInsert,
      })
      .returning();
    return result;
  }

  async getSettings(): Promise<Settings | undefined> {
    throw new Error("Unscoped settings are forbidden. Use getSettingsBySchoolId(schoolId).");
  }

  async upsertSettings(_insertSettings: InsertSettings): Promise<Settings> {
    throw new Error("Unscoped settings are forbidden. Use upsertSettingsForSchool(schoolId, input).");
  }

  // Teacher Settings
  async getTeacherSettings(teacherId: string): Promise<TeacherSettings | undefined> {
    const [result] = await db
      .select()
      .from(teacherSettings)
      .where(eq(teacherSettings.teacherId, teacherId))
      .limit(1);
    return result || undefined;
  }

  async upsertTeacherSettings(insertSettings: InsertTeacherSettings): Promise<TeacherSettings> {
    const existing = await this.getTeacherSettings(insertSettings.teacherId);
    
    if (existing) {
      const [updated] = await db
        .update(teacherSettings)
        .set({ ...insertSettings, updatedAt: new Date() })
        .where(eq(teacherSettings.teacherId, insertSettings.teacherId))
        .returning();
      return updated;
    } else {
      const [created] = await db
        .insert(teacherSettings)
        .values(insertSettings)
        .returning();
      return created;
    }
  }

  // Teacher-Student Relationships
  async assignStudentToTeacher(teacherId: string, studentId: string): Promise<TeacherStudent> {
    const [result] = await db
      .insert(teacherStudents)
      .values({ teacherId, studentId })
      .onConflictDoNothing()
      .returning();
    
    if (result) {
      return result;
    }
    
    const [existing] = await db
      .select()
      .from(teacherStudents)
      .where(
        drizzleSql`${teacherStudents.teacherId} = ${teacherId} AND ${teacherStudents.studentId} = ${studentId}`
      )
      .limit(1);
    return existing!;
  }

  async unassignStudentFromTeacher(teacherId: string, studentId: string): Promise<boolean> {
    const result = await db
      .delete(teacherStudents)
      .where(
        drizzleSql`${teacherStudents.teacherId} = ${teacherId} AND ${teacherStudents.studentId} = ${studentId}`
      );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async getTeacherStudents(teacherId: string): Promise<string[]> {
    const results = await db
      .select({ studentId: teacherStudents.studentId })
      .from(teacherStudents)
      .where(eq(teacherStudents.teacherId, teacherId));
    return results.map((row: { studentId: string }) => row.studentId);
  }

  async getStudentTeachers(studentId: string): Promise<string[]> {
    const results = await db
      .select({ teacherId: teacherStudents.teacherId })
      .from(teacherStudents)
      .where(eq(teacherStudents.studentId, studentId));
    return results.map((row: { teacherId: string }) => row.teacherId);
  }

  // Flight Paths
  async getFlightPath(id: string): Promise<FlightPath | undefined> {
    const [flightPath] = await db.select().from(flightPaths).where(eq(flightPaths.id, id));
    return flightPath || undefined;
  }

  async getFlightPathsBySchool(schoolId: string): Promise<FlightPath[]> {
    return await db.select().from(flightPaths).where(eq(flightPaths.schoolId, schoolId));
  }

  async getFlightPathsByTeacher(teacherId: string): Promise<FlightPath[]> {
    return await db
      .select()
      .from(flightPaths)
      .where(eq(flightPaths.teacherId, teacherId));
  }

  async createFlightPath(insertFlightPath: InsertFlightPath): Promise<FlightPath> {
    const [created] = await db
      .insert(flightPaths)
      .values(insertFlightPath)
      .returning();
    return created;
  }

  async updateFlightPath(id: string, updates: Partial<InsertFlightPath>): Promise<FlightPath | undefined> {
    const [updated] = await db
      .update(flightPaths)
      .set(updates)
      .where(eq(flightPaths.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteFlightPath(id: string): Promise<boolean> {
    const result = await db.delete(flightPaths).where(eq(flightPaths.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Block Lists
  async getBlockList(id: string): Promise<BlockList | undefined> {
    const [blockList] = await db.select().from(blockLists).where(eq(blockLists.id, id));
    return blockList || undefined;
  }

  async getBlockListsBySchool(schoolId: string): Promise<BlockList[]> {
    return await db.select().from(blockLists).where(eq(blockLists.schoolId, schoolId));
  }

  async getBlockListsByTeacher(teacherId: string): Promise<BlockList[]> {
    return await db.select().from(blockLists).where(eq(blockLists.teacherId, teacherId));
  }

  async createBlockList(insertBlockList: InsertBlockList): Promise<BlockList> {
    const [created] = await db.insert(blockLists).values(insertBlockList).returning();
    return created;
  }

  async updateBlockList(id: string, updates: Partial<InsertBlockList>): Promise<BlockList | undefined> {
    const [updated] = await db.update(blockLists).set(updates).where(eq(blockLists.id, id)).returning();
    return updated || undefined;
  }

  async deleteBlockList(id: string): Promise<boolean> {
    const result = await db.delete(blockLists).where(eq(blockLists.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Student Groups
  async getStudentGroup(id: string): Promise<StudentGroup | undefined> {
    const [group] = await db.select().from(studentGroups).where(eq(studentGroups.id, id));
    return group || undefined;
  }

  async getStudentGroupsBySchool(schoolId: string): Promise<StudentGroup[]> {
    return await db.select().from(studentGroups).where(eq(studentGroups.schoolId, schoolId));
  }

  async getStudentGroupsByTeacher(teacherId: string): Promise<StudentGroup[]> {
    return await db
      .select()
      .from(studentGroups)
      .where(eq(studentGroups.teacherId, teacherId));
  }

  async createStudentGroup(insertGroup: InsertStudentGroup): Promise<StudentGroup> {
    const [created] = await db
      .insert(studentGroups)
      .values(insertGroup)
      .returning();
    return created;
  }

  async updateStudentGroup(id: string, updates: Partial<InsertStudentGroup>): Promise<StudentGroup | undefined> {
    const [updated] = await db
      .update(studentGroups)
      .set(updates)
      .where(eq(studentGroups.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteStudentGroup(id: string): Promise<boolean> {
    const result = await db.delete(studentGroups).where(eq(studentGroups.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Messages
  async getMessage(id: string): Promise<Message | undefined> {
    const [message] = await db.select().from(messages).where(eq(messages.id, id));
    return message || undefined;
  }

  async getMessagesByStudent(studentId: string): Promise<Message[]> {
    return await db
      .select()
      .from(messages)
      .where(drizzleSql`${messages.toStudentId} = ${studentId} OR ${messages.toStudentId} IS NULL`)
      .orderBy(desc(messages.timestamp));
  }

  async getAllMessages(): Promise<Message[]> {
    return await db.select().from(messages).orderBy(desc(messages.timestamp));
  }

  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    const [created] = await db
      .insert(messages)
      .values(insertMessage)
      .returning();
    return created;
  }

  // Check-ins
  async getCheckIn(id: string): Promise<CheckIn | undefined> {
    const [checkIn] = await db.select().from(checkIns).where(eq(checkIns.id, id));
    return checkIn || undefined;
  }

  async getCheckInsByStudent(studentId: string): Promise<CheckIn[]> {
    return await db
      .select()
      .from(checkIns)
      .where(eq(checkIns.studentId, studentId))
      .orderBy(desc(checkIns.timestamp));
  }

  async getAllCheckIns(): Promise<CheckIn[]> {
    return await db.select().from(checkIns).orderBy(desc(checkIns.timestamp));
  }

  async createCheckIn(insertCheckIn: InsertCheckIn): Promise<CheckIn> {
    const [created] = await db
      .insert(checkIns)
      .values(insertCheckIn)
      .returning();
    return created;
  }

  // Polls
  async getPoll(id: string): Promise<Poll | undefined> {
    const [poll] = await db.select().from(polls).where(eq(polls.id, id));
    return poll || undefined;
  }

  async getPollsBySession(sessionId: string): Promise<Poll[]> {
    return await db.select().from(polls).where(eq(polls.sessionId, sessionId)).orderBy(desc(polls.createdAt));
  }

  async getActivePollsBySession(sessionId: string): Promise<Poll[]> {
    return await db.select().from(polls).where(and(eq(polls.sessionId, sessionId), eq(polls.isActive, true)));
  }

  async createPoll(insertPoll: InsertPoll): Promise<Poll> {
    const [created] = await db.insert(polls).values(insertPoll).returning();
    return created;
  }

  async closePoll(pollId: string): Promise<Poll | undefined> {
    const [updated] = await db
      .update(polls)
      .set({ isActive: false, closedAt: new Date() })
      .where(eq(polls.id, pollId))
      .returning();
    return updated || undefined;
  }

  async getPollResponse(id: string): Promise<PollResponse | undefined> {
    const [response] = await db.select().from(pollResponses).where(eq(pollResponses.id, id));
    return response || undefined;
  }

  async getPollResponsesByPoll(pollId: string): Promise<PollResponse[]> {
    return await db.select().from(pollResponses).where(eq(pollResponses.pollId, pollId));
  }

  async createPollResponse(insertResponse: InsertPollResponse): Promise<PollResponse> {
    const [created] = await db.insert(pollResponses).values(insertResponse).returning();
    return created;
  }

  async getPollResults(pollId: string): Promise<{ option: number; count: number }[]> {
    const results = await db
      .select({
        option: pollResponses.selectedOption,
        count: sql<number>`count(*)::int`,
      })
      .from(pollResponses)
      .where(eq(pollResponses.pollId, pollId))
      .groupBy(pollResponses.selectedOption);
    return results;
  }

  // Subgroups
  async getSubgroup(id: string): Promise<Subgroup | undefined> {
    const [subgroup] = await db.select().from(subgroups).where(eq(subgroups.id, id));
    return subgroup || undefined;
  }

  async getSubgroupsByGroup(groupId: string): Promise<Subgroup[]> {
    return await db.select().from(subgroups).where(eq(subgroups.groupId, groupId)).orderBy(subgroups.name);
  }

  async createSubgroup(insertSubgroup: InsertSubgroup): Promise<Subgroup> {
    const [created] = await db.insert(subgroups).values(insertSubgroup).returning();
    return created;
  }

  async updateSubgroup(id: string, updates: Partial<InsertSubgroup>): Promise<Subgroup | undefined> {
    const [updated] = await db.update(subgroups).set(updates).where(eq(subgroups.id, id)).returning();
    return updated || undefined;
  }

  async deleteSubgroup(id: string): Promise<boolean> {
    // Delete members first
    await db.delete(subgroupMembers).where(eq(subgroupMembers.subgroupId, id));
    const result = await db.delete(subgroups).where(eq(subgroups.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  async getSubgroupMembers(subgroupId: string): Promise<string[]> {
    const members = await db
      .select({ studentId: subgroupMembers.studentId })
      .from(subgroupMembers)
      .where(eq(subgroupMembers.subgroupId, subgroupId));
    return members.map(m => m.studentId);
  }

  async addSubgroupMember(subgroupId: string, studentId: string): Promise<SubgroupMember> {
    const [created] = await db.insert(subgroupMembers).values({ subgroupId, studentId }).returning();
    return created;
  }

  async removeSubgroupMember(subgroupId: string, studentId: string): Promise<boolean> {
    const result = await db
      .delete(subgroupMembers)
      .where(and(eq(subgroupMembers.subgroupId, subgroupId), eq(subgroupMembers.studentId, studentId)));
    return result.rowCount !== null && result.rowCount > 0;
  }

  async getStudentSubgroups(studentId: string): Promise<string[]> {
    const memberships = await db
      .select({ subgroupId: subgroupMembers.subgroupId })
      .from(subgroupMembers)
      .where(eq(subgroupMembers.studentId, studentId));
    return memberships.map(m => m.subgroupId);
  }

  // Dashboard Tabs
  async getDashboardTabs(teacherId: string): Promise<DashboardTab[]> {
    return await db
      .select()
      .from(dashboardTabs)
      .where(eq(dashboardTabs.teacherId, teacherId))
      .orderBy(dashboardTabs.order);
  }

  async getDashboardTab(id: string): Promise<DashboardTab | undefined> {
    const [tab] = await db
      .select()
      .from(dashboardTabs)
      .where(eq(dashboardTabs.id, id));
    return tab || undefined;
  }

  async createDashboardTab(insertTab: InsertDashboardTab): Promise<DashboardTab> {
    const [created] = await db
      .insert(dashboardTabs)
      .values(insertTab)
      .returning();
    return created;
  }

  async updateDashboardTab(id: string, updates: Partial<InsertDashboardTab>): Promise<DashboardTab | undefined> {
    const [updated] = await db
      .update(dashboardTabs)
      .set(updates)
      .where(eq(dashboardTabs.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteDashboardTab(id: string): Promise<boolean> {
    const result = await db
      .delete(dashboardTabs)
      .where(eq(dashboardTabs.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Groups (Class Rosters)
  async getGroup(id: string): Promise<Group | undefined> {
    const [group] = await db
      .select()
      .from(groups)
      .where(eq(groups.id, id));
    return group || undefined;
  }

  async getGroupsBySchool(schoolId: string): Promise<Group[]> {
    return await db
      .select()
      .from(groups)
      .where(eq(groups.schoolId, schoolId))
      .orderBy(groups.createdAt);
  }

  async getGroupsByTeacher(teacherId: string): Promise<Group[]> {
    return await db
      .select()
      .from(groups)
      .where(eq(groups.teacherId, teacherId))
      .orderBy(groups.createdAt);
  }

  async createGroup(insertGroup: InsertGroup): Promise<Group> {
    const [created] = await db
      .insert(groups)
      .values(insertGroup)
      .returning();
    return created;
  }

  async updateGroup(id: string, updates: Partial<InsertGroup>): Promise<Group | undefined> {
    const [updated] = await db
      .update(groups)
      .set(updates)
      .where(eq(groups.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteGroup(id: string): Promise<boolean> {
    const result = await db.delete(groups).where(eq(groups.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Group Students (Many-to-many)
  async getGroupStudents(groupId: string): Promise<string[]> {
    const results = await db
      .select()
      .from(groupStudents)
      .where(eq(groupStudents.groupId, groupId));
    return results.map((row: { studentId: string }) => row.studentId);
  }

  async assignStudentToGroup(groupId: string, studentId: string): Promise<GroupStudent> {
    const [created] = await db
      .insert(groupStudents)
      .values({ groupId, studentId })
      .returning();
    return created;
  }

  async unassignStudentFromGroup(groupId: string, studentId: string): Promise<boolean> {
    const result = await db
      .delete(groupStudents)
      .where(
        drizzleSql`${groupStudents.groupId} = ${groupId} AND ${groupStudents.studentId} = ${studentId}`
      );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async getStudentGroups(studentId: string): Promise<string[]> {
    const results = await db
      .select()
      .from(groupStudents)
      .where(eq(groupStudents.studentId, studentId));
    return results.map((row: { groupId: string }) => row.groupId);
  }

  // Sessions
  async getSession(id: string): Promise<Session | undefined> {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id));
    return session || undefined;
  }

  async getActiveSessionByTeacher(teacherId: string): Promise<Session | undefined> {
    const [session] = await db
      .select()
      .from(sessions)
      .where(
        drizzleSql`${sessions.teacherId} = ${teacherId} AND ${sessions.endTime} IS NULL`
      )
      .orderBy(desc(sessions.startTime));
    return session || undefined;
  }

  async getActiveSessions(schoolId: string): Promise<Session[]> {
    const rows = await db
      .select({ sessions })
      .from(sessions)
      .innerJoin(groups, eq(groups.id, sessions.groupId))
      .where(drizzleSql`${sessions.endTime} IS NULL AND ${groups.schoolId} = ${schoolId}`)
      .orderBy(desc(sessions.startTime));
    return rows.map((row: { sessions: Session }) => row.sessions);
  }

  async getSessionsBySchool(schoolId: string): Promise<Session[]> {
    const rows = await db
      .select({ sessions })
      .from(sessions)
      .innerJoin(groups, eq(groups.id, sessions.groupId))
      .where(eq(groups.schoolId, schoolId))
      .orderBy(desc(sessions.startTime));
    return rows.map((row: { sessions: Session }) => row.sessions);
  }

  async startSession(insertSession: InsertSession): Promise<Session> {
    const [created] = await db
      .insert(sessions)
      .values(insertSession)
      .returning();
    return created;
  }

  async endSession(sessionId: string): Promise<Session | undefined> {
    const [updated] = await db
      .update(sessions)
      .set({ endTime: drizzleSql`now()` })
      .where(eq(sessions.id, sessionId))
      .returning();
    return updated || undefined;
  }

  // Chat Messages (Two-Way Chat)
  async createChatMessage(message: InsertChatMessage): Promise<DbChatMessage> {
    const [created] = await db
      .insert(chatMessages)
      .values(message)
      .returning();
    return created;
  }

  async getStudentMessagesForSchool(schoolId: string, options?: { since?: Date; limit?: number }): Promise<DbChatMessage[]> {
    // Get all student messages for this school by joining with students table
    // We need to get messages where senderType='student' and the sender is from this school
    const limit = options?.limit || 50;
    const since = options?.since;

    let query = db
      .select({ chatMessages })
      .from(chatMessages)
      .innerJoin(students, eq(students.id, chatMessages.senderId))
      .where(
        since
          ? drizzleSql`${chatMessages.senderType} = 'student' AND ${students.schoolId} = ${schoolId} AND ${chatMessages.createdAt} > ${since}`
          : drizzleSql`${chatMessages.senderType} = 'student' AND ${students.schoolId} = ${schoolId}`
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);

    const rows = await query;
    return rows.map((row: { chatMessages: DbChatMessage }) => row.chatMessages);
  }

  async getChatMessagesBySession(sessionId: string): Promise<DbChatMessage[]> {
    return await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(desc(chatMessages.createdAt));
  }

  async deleteChatMessage(messageId: string): Promise<boolean> {
    const result = await db.delete(chatMessages).where(eq(chatMessages.id, messageId));
    return (result.rowCount ?? 0) > 0;
  }

  // Audit Logs
  async createAuditLog(log: InsertAuditLog): Promise<AuditLog> {
    const [created] = await db.insert(auditLogs).values(log).returning();
    return created;
  }

  async getAuditLogsBySchool(schoolId: string, options?: {
    action?: string;
    userId?: string;
    since?: Date;
    until?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ logs: AuditLog[]; total: number }> {
    const limit = options?.limit || 50;
    const offset = options?.offset || 0;

    // Build conditions array
    const conditions = [eq(auditLogs.schoolId, schoolId)];
    if (options?.action) {
      conditions.push(eq(auditLogs.action, options.action));
    }
    if (options?.userId) {
      conditions.push(eq(auditLogs.userId, options.userId));
    }
    if (options?.since) {
      conditions.push(sql`${auditLogs.createdAt} >= ${options.since}`);
    }
    if (options?.until) {
      conditions.push(sql`${auditLogs.createdAt} <= ${options.until}`);
    }

    // Get total count
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(auditLogs)
      .where(and(...conditions));

    // Get paginated logs
    const logs = await db
      .select()
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return { logs, total: Number(count) };
  }
}

// Export storage instance based on environment
export const storage: IStorage = process.env.DATABASE_URL 
  ? new DatabaseStorage() 
  : new MemStorage();

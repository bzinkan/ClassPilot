import {
  type User,
  type InsertUser,
  type Device,
  type InsertDevice,
  type Student,
  type InsertStudent,
  type StudentStatus,
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
  type StudentGroup,
  type InsertStudentGroup,
  type Message,
  type InsertMessage,
  type CheckIn,
  type InsertCheckIn,
  users,
  devices,
  students,
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
  studentGroups,
  messages,
  checkIns,
} from "@shared/schema";
import { randomUUID } from "crypto";
import { db } from "./db";
import { eq, desc, lt, sql as drizzleSql, inArray } from "drizzle-orm";

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getAllUsers(): Promise<User[]>;
  deleteUser(id: string): Promise<boolean>;

  // Devices (Chromebooks)
  getDevice(deviceId: string): Promise<Device | undefined>;
  getAllDevices(): Promise<Device[]>;
  registerDevice(device: InsertDevice): Promise<Device>;
  updateDevice(deviceId: string, updates: Partial<Omit<InsertDevice, 'deviceId'>>): Promise<Device | undefined>;
  deleteDevice(deviceId: string): Promise<boolean>;

  // Students (assigned to devices)
  getStudent(studentId: string): Promise<Student | undefined>;
  getStudentByEmail(email: string): Promise<Student | undefined>;
  getStudentsByDevice(deviceId: string): Promise<Student[]>;
  getAllStudents(): Promise<Student[]>;
  createStudent(student: InsertStudent): Promise<Student>;
  updateStudent(studentId: string, updates: Partial<InsertStudent>): Promise<Student | undefined>;
  deleteStudent(studentId: string): Promise<boolean>;

  // Student Status (in-memory tracking - per student, not device)
  getStudentStatus(studentId: string): Promise<StudentStatus | undefined>;
  getAllStudentStatuses(): Promise<StudentStatus[]>;
  updateStudentStatus(status: StudentStatus): Promise<void>;
  getActiveStudentForDevice(deviceId: string): Promise<Student | undefined>;
  setActiveStudentForDevice(deviceId: string, studentId: string | null): Promise<void>;

  // Heartbeats
  addHeartbeat(heartbeat: InsertHeartbeat): Promise<Heartbeat>;
  getHeartbeatsByDevice(deviceId: string, limit?: number): Promise<Heartbeat[]>;
  getHeartbeatsByStudent(studentId: string, limit?: number): Promise<Heartbeat[]>;
  getAllHeartbeats(): Promise<Heartbeat[]>;
  cleanupOldHeartbeats(retentionHours: number): Promise<number>;

  // Events
  addEvent(event: InsertEvent): Promise<Event>;
  getEventsByDevice(deviceId: string): Promise<Event[]>;
  getEventsByStudent(studentId: string): Promise<Event[]>;

  // Rosters
  getRoster(classId: string): Promise<Roster | undefined>;
  getAllRosters(): Promise<Roster[]>;
  upsertRoster(roster: InsertRoster): Promise<Roster>;

  // Settings
  getSettings(): Promise<Settings | undefined>;
  upsertSettings(settings: InsertSettings): Promise<Settings>;

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
  getGroupsByTeacher(teacherId: string): Promise<Group[]>;
  getAllGroups(): Promise<Group[]>;
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
  getActiveSessions(): Promise<Session[]>; // All currently active sessions
  getAllSessions(): Promise<Session[]>;
  startSession(session: InsertSession): Promise<Session>;
  endSession(sessionId: string): Promise<Session | undefined>;

  // Flight Paths (teacher-scoped)
  getFlightPath(id: string): Promise<FlightPath | undefined>;
  getAllFlightPaths(): Promise<FlightPath[]>;
  getFlightPathsByTeacher(teacherId: string): Promise<FlightPath[]>; // Teacher-specific flight paths
  createFlightPath(flightPath: InsertFlightPath): Promise<FlightPath>;
  updateFlightPath(id: string, updates: Partial<InsertFlightPath>): Promise<FlightPath | undefined>;
  deleteFlightPath(id: string): Promise<boolean>;

  // Student Groups (teacher-scoped)
  getStudentGroup(id: string): Promise<StudentGroup | undefined>;
  getAllStudentGroups(): Promise<StudentGroup[]>;
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
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private devices: Map<string, Device>;
  private students: Map<string, Student>; // Keyed by student ID
  private activeStudents: Map<string, string>; // deviceId -> studentId
  private studentStatuses: Map<string, StudentStatus>; // Keyed by student ID
  private heartbeats: Heartbeat[];
  private events: Event[];
  private rosters: Map<string, Roster>;
  private settings: Settings | undefined;
  private teacherSettings: Map<string, TeacherSettings>;
  private teacherStudents: TeacherStudent[];
  private flightPaths: Map<string, FlightPath>;
  private studentGroups: Map<string, StudentGroup>;
  private messages: Message[];
  private checkIns: CheckIn[];

  constructor() {
    this.users = new Map();
    this.devices = new Map();
    this.students = new Map();
    this.activeStudents = new Map();
    this.studentStatuses = new Map();
    this.heartbeats = [];
    this.events = [];
    this.rosters = new Map();
    this.teacherSettings = new Map();
    this.teacherStudents = [];
    this.flightPaths = new Map();
    this.studentGroups = new Map();
    this.messages = [];
    this.checkIns = [];
  }

  // Helper to calculate status from lastSeenAt
  private calculateStatus(lastSeenAt: number): 'online' | 'idle' | 'offline' {
    const timeSinceLastSeen = Date.now() - lastSeenAt;
    if (timeSinceLastSeen < 30000) return 'online';
    if (timeSinceLastSeen < 120000) return 'idle';
    return 'offline';
  }

  // Users
  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = {
      id,
      username: insertUser.username,
      password: insertUser.password,
      role: insertUser.role || 'teacher',
      schoolName: insertUser.schoolName || 'School',
    };
    this.users.set(id, user);
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return Array.from(this.users.values());
  }

  async deleteUser(id: string): Promise<boolean> {
    return this.users.delete(id);
  }

  // Devices
  async getDevice(deviceId: string): Promise<Device | undefined> {
    return this.devices.get(deviceId);
  }

  async getAllDevices(): Promise<Device[]> {
    return Array.from(this.devices.values());
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
    const existed = this.devices.has(deviceId);
    this.devices.delete(deviceId);
    
    // Delete all students assigned to this device
    const studentsToDelete = Array.from(this.students.values())
      .filter(s => s.deviceId === deviceId);
    for (const student of studentsToDelete) {
      this.students.delete(student.id);
      this.studentStatuses.delete(student.id);
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

  async getStudentsByDevice(deviceId: string): Promise<Student[]> {
    return Array.from(this.students.values())
      .filter(s => s.deviceId === deviceId);
  }

  async getAllStudents(): Promise<Student[]> {
    return Array.from(this.students.values());
  }

  async createStudent(insertStudent: InsertStudent): Promise<Student> {
    const id = randomUUID();
    const student: Student = {
      id,
      deviceId: insertStudent.deviceId,
      studentName: insertStudent.studentName,
      studentEmail: insertStudent.studentEmail ?? null,
      gradeLevel: insertStudent.gradeLevel ?? null,
      createdAt: new Date(),
    };
    this.students.set(id, student);
    
    // Initialize status for this student
    const device = this.devices.get(student.deviceId);
    const status: StudentStatus = {
      studentId: student.id,
      deviceId: student.deviceId,
      deviceName: device?.deviceName ?? undefined,
      studentName: student.studentName,
      classId: device?.classId || '',
      gradeLevel: student.gradeLevel ?? undefined,
      activeTabTitle: "",
      activeTabUrl: "",
      lastSeenAt: 0,
      isSharing: false,
      screenLocked: false,
      flightPathActive: false,
      activeFlightPathName: undefined,
      cameraActive: false,
      status: 'offline',
    };
    this.studentStatuses.set(student.id, status);
    
    return student;
  }

  async updateStudent(studentId: string, updates: Partial<InsertStudent>): Promise<Student | undefined> {
    const student = this.students.get(studentId);
    if (!student) return undefined;
    
    Object.assign(student, updates);
    this.students.set(studentId, student);
    
    // Update status map if relevant fields changed
    const status = this.studentStatuses.get(studentId);
    if (status) {
      if (updates.studentName) {
        status.studentName = updates.studentName;
      }
      if (updates.gradeLevel !== undefined) {
        status.gradeLevel = updates.gradeLevel ?? undefined;
      }
      if (updates.deviceId) {
        status.deviceId = updates.deviceId;
        const device = this.devices.get(updates.deviceId);
        if (device) {
          status.deviceName = device.deviceName ?? undefined;
          status.classId = device.classId;
        }
      }
      this.studentStatuses.set(studentId, status);
    }
    
    return student;
  }

  async deleteStudent(studentId: string): Promise<boolean> {
    const student = this.students.get(studentId);
    if (!student) return false;
    
    const existed = this.students.delete(studentId);
    this.studentStatuses.delete(studentId);
    
    // Clear from active students if this student is active
    const entries = Array.from(this.activeStudents.entries());
    for (const [deviceId, activeStudentId] of entries) {
      if (activeStudentId === studentId) {
        this.activeStudents.delete(deviceId);
      }
    }
    
    // Delete related data
    this.heartbeats = this.heartbeats.filter(h => h.studentId !== studentId);
    this.events = this.events.filter(e => e.studentId !== studentId);
    
    return existed;
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

  async getAllStudentStatuses(): Promise<StudentStatus[]> {
    const statuses = Array.from(this.studentStatuses.values());
    
    return statuses.map(status => ({
      ...status,
      status: this.calculateStatus(status.lastSeenAt),
    }));
  }

  async updateStudentStatus(status: StudentStatus): Promise<void> {
    this.studentStatuses.set(status.studentId, status);
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
  async addHeartbeat(insertHeartbeat: InsertHeartbeat): Promise<Heartbeat> {
    const heartbeat: Heartbeat = {
      id: randomUUID(),
      deviceId: insertHeartbeat.deviceId,
      studentId: insertHeartbeat.studentId ?? null,
      activeTabTitle: insertHeartbeat.activeTabTitle,
      activeTabUrl: insertHeartbeat.activeTabUrl,
      favicon: insertHeartbeat.favicon ?? null,
      screenLocked: insertHeartbeat.screenLocked ?? false,
      flightPathActive: insertHeartbeat.flightPathActive ?? false,
      activeFlightPathName: insertHeartbeat.activeFlightPathName ?? null,
      isSharing: insertHeartbeat.isSharing ?? false,
      cameraActive: insertHeartbeat.cameraActive ?? false,
      timestamp: new Date(),
    };
    this.heartbeats.push(heartbeat);
    
    // Update or create student status if studentId is provided
    if (heartbeat.studentId) {
      let status = this.studentStatuses.get(heartbeat.studentId);
      
      // If status doesn't exist, create it from student data
      if (!status) {
        const student = this.students.get(heartbeat.studentId);
        if (student) {
          const device = this.devices.get(student.deviceId);
          status = {
            studentId: student.id,
            deviceId: student.deviceId,
            deviceName: device?.deviceName ?? undefined,
            studentName: student.studentName,
            classId: device?.classId || '',
            gradeLevel: student.gradeLevel ?? undefined,
            activeTabTitle: heartbeat.activeTabTitle,
            activeTabUrl: heartbeat.activeTabUrl,
            favicon: heartbeat.favicon ?? undefined,
            lastSeenAt: Date.now(),
            isSharing: heartbeat.isSharing ?? false,
            screenLocked: heartbeat.screenLocked ?? false,
            flightPathActive: heartbeat.flightPathActive ?? false,
            activeFlightPathName: heartbeat.activeFlightPathName || undefined,
            cameraActive: heartbeat.cameraActive ?? false,
            status: 'online',
          };
          this.studentStatuses.set(heartbeat.studentId, status);
          console.log('Created StudentStatus:', { studentId: student.id, studentName: student.studentName, gradeLevel: student.gradeLevel });
        } else {
          console.warn('Heartbeat has studentId but student not found in database:', heartbeat.studentId);
        }
      } else {
        // Update existing status
        const now = Date.now();
        status.activeTabTitle = heartbeat.activeTabTitle;
        status.activeTabUrl = heartbeat.activeTabUrl;
        status.favicon = heartbeat.favicon ?? undefined;
        
        // Only update screenLocked from heartbeat if server hasn't set it recently (within 5 seconds)
        const serverSetRecently = status.screenLockedSetAt && (now - status.screenLockedSetAt) < 5000;
        if (!serverSetRecently) {
          status.screenLocked = heartbeat.screenLocked ?? false;
        }
        
        status.isSharing = heartbeat.isSharing ?? false;
        status.flightPathActive = heartbeat.flightPathActive ?? false;
        status.activeFlightPathName = heartbeat.activeFlightPathName || undefined;
        status.cameraActive = heartbeat.cameraActive ?? false;
        status.lastSeenAt = now;
        status.status = this.calculateStatus(now);
        
        // Calculate current URL duration
        status.currentUrlDuration = this.calculateCurrentUrlDurationMem(heartbeat.studentId, heartbeat.activeTabUrl);
        
        this.studentStatuses.set(heartbeat.studentId, status);
      }
    }
    
    return heartbeat;
  }

  // Helper function to calculate duration on current URL (MemStorage)
  private calculateCurrentUrlDurationMem(studentId: string, currentUrl: string): number {
    // Get recent heartbeats for this student
    const studentHeartbeats = this.heartbeats
      .filter(h => h.studentId === studentId)
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

  async getAllHeartbeats(): Promise<Heartbeat[]> {
    return this.heartbeats
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

  async getAllRosters(): Promise<Roster[]> {
    return Array.from(this.rosters.values());
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
  async getSettings(): Promise<Settings | undefined> {
    return this.settings;
  }

  async upsertSettings(insertSettings: InsertSettings): Promise<Settings> {
    const settings: Settings = {
      id: this.settings?.id || randomUUID(),
      schoolId: insertSettings.schoolId,
      schoolName: insertSettings.schoolName,
      wsSharedKey: insertSettings.wsSharedKey,
      retentionHours: insertSettings.retentionHours ?? "24",
      blockedDomains: insertSettings.blockedDomains ?? null,
      allowedDomains: insertSettings.allowedDomains ?? null,
      ipAllowlist: insertSettings.ipAllowlist ?? null,
      gradeLevels: insertSettings.gradeLevels ?? null,
      maxTabsPerStudent: insertSettings.maxTabsPerStudent ?? null,
      activeFlightPathId: insertSettings.activeFlightPathId ?? null,
      enableTrackingHours: insertSettings.enableTrackingHours ?? false,
      trackingStartTime: insertSettings.trackingStartTime ?? "08:00",
      trackingEndTime: insertSettings.trackingEndTime ?? "15:00",
      schoolTimezone: insertSettings.schoolTimezone ?? "America/New_York",
      trackingDays: insertSettings.trackingDays ?? null,
    };
    this.settings = settings;
    return settings;
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

  async getAllFlightPaths(): Promise<FlightPath[]> {
    return Array.from(this.flightPaths.values());
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

  // Student Groups
  async getStudentGroup(id: string): Promise<StudentGroup | undefined> {
    return this.studentGroups.get(id);
  }

  async getAllStudentGroups(): Promise<StudentGroup[]> {
    return Array.from(this.studentGroups.values());
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

  async getGroupsByTeacher(teacherId: string): Promise<Group[]> {
    return [];
  }

  async getAllGroups(): Promise<Group[]> {
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

  async getActiveSessions(): Promise<Session[]> {
    return [];
  }

  async getAllSessions(): Promise<Session[]> {
    return [];
  }

  async startSession(session: InsertSession): Promise<Session> {
    throw new Error("Sessions not supported in memory storage");
  }

  async endSession(sessionId: string): Promise<Session | undefined> {
    return undefined;
  }
}

// Database storage implementation
export class DatabaseStorage implements IStorage {
  private activeStudents: Map<string, string>; // deviceId -> studentId
  private studentStatuses: Map<string, StudentStatus>; // studentId -> status

  constructor() {
    this.activeStudents = new Map();
    this.studentStatuses = new Map();
  }

  // Helper to calculate status from lastSeenAt
  private calculateStatus(lastSeenAt: number): 'online' | 'idle' | 'offline' {
    const timeSinceLastSeen = Date.now() - lastSeenAt;
    if (timeSinceLastSeen < 30000) return 'online';
    if (timeSinceLastSeen < 120000) return 'idle';
    return 'offline';
  }

  // Rehydrate studentStatuses from database on startup
  async rehydrateStatuses(): Promise<void> {
    // Get all students with their device info
    const allStudents = await this.getAllStudents();
    const allDevices = await this.getAllDevices();
    const deviceMap = new Map(allDevices.map(d => [d.deviceId, d]));
    
    for (const student of allStudents) {
      const device = deviceMap.get(student.deviceId);
      
      // Get most recent heartbeat for this student to restore actual last seen time
      const recentHeartbeats = await this.getHeartbeatsByStudent(student.id, 1);
      const lastHeartbeat = recentHeartbeats[0];
      
      let lastSeenAt = 0;
      let activeTabTitle = "";
      let activeTabUrl = "";
      let favicon: string | undefined = undefined;
      
      if (lastHeartbeat) {
        lastSeenAt = new Date(lastHeartbeat.timestamp).getTime();
        activeTabTitle = lastHeartbeat.activeTabTitle;
        activeTabUrl = lastHeartbeat.activeTabUrl;
        favicon = lastHeartbeat.favicon || undefined;
      }
      
      const status: StudentStatus = {
        studentId: student.id,
        deviceId: student.deviceId,
        deviceName: device?.deviceName ?? undefined,
        studentName: student.studentName,
        classId: device?.classId || '',
        gradeLevel: student.gradeLevel ?? undefined,
        activeTabTitle,
        activeTabUrl,
        favicon,
        lastSeenAt,
        isSharing: false,
        screenLocked: false,
        flightPathActive: false,
        activeFlightPathName: undefined,
        cameraActive: false,
        status: this.calculateStatus(lastSeenAt),
      };
      this.studentStatuses.set(student.id, status);
    }
  }

  // Users
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users);
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.id, id)).returning();
    return result.length > 0;
  }

  // Devices
  async getDevice(deviceId: string): Promise<Device | undefined> {
    const [device] = await db.select().from(devices).where(eq(devices.deviceId, deviceId));
    return device || undefined;
  }

  async getAllDevices(): Promise<Device[]> {
    return await db.select().from(devices);
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
    
    // Update statuses for all students on this device
    const studentsOnDevice = await this.getStudentsByDevice(deviceId);
    for (const student of studentsOnDevice) {
      const status = this.studentStatuses.get(student.id);
      if (status) {
        if (updates.deviceName !== undefined) {
          status.deviceName = updates.deviceName ?? undefined;
        }
        if (updates.classId !== undefined) {
          status.classId = updates.classId;
        }
        this.studentStatuses.set(student.id, status);
      }
    }
    
    return device;
  }

  async deleteDevice(deviceId: string): Promise<boolean> {
    // Get all students on this device
    const studentsOnDevice = await this.getStudentsByDevice(deviceId);
    const studentIds = studentsOnDevice.map(s => s.id);
    
    // Delete heartbeats for this device
    await db.delete(heartbeats).where(eq(heartbeats.deviceId, deviceId));
    
    // Delete events for this device
    await db.delete(events).where(eq(events.deviceId, deviceId));
    
    // Delete all students on this device
    if (studentIds.length > 0) {
      await db.delete(students).where(inArray(students.id, studentIds));
      
      // Remove from in-memory status maps
      for (const studentId of studentIds) {
        this.studentStatuses.delete(studentId);
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

  async getStudentsByDevice(deviceId: string): Promise<Student[]> {
    return await db.select().from(students).where(eq(students.deviceId, deviceId));
  }

  async getAllStudents(): Promise<Student[]> {
    return await db.select().from(students);
  }

  async createStudent(insertStudent: InsertStudent): Promise<Student> {
    const [student] = await db
      .insert(students)
      .values(insertStudent)
      .returning();
    
    // Get device info for this student
    const device = await this.getDevice(student.deviceId);
    
    // Get most recent heartbeat to initialize status with real data
    const recentHeartbeats = await this.getHeartbeatsByStudent(student.id, 1);
    const lastHeartbeat = recentHeartbeats[0];
    
    let lastSeenAt = 0;
    let activeTabTitle = "";
    let activeTabUrl = "";
    let favicon: string | undefined = undefined;
    
    if (lastHeartbeat) {
      lastSeenAt = new Date(lastHeartbeat.timestamp).getTime();
      activeTabTitle = lastHeartbeat.activeTabTitle;
      activeTabUrl = lastHeartbeat.activeTabUrl;
      favicon = lastHeartbeat.favicon || undefined;
    }
    
    // Initialize status
    const status: StudentStatus = {
      studentId: student.id,
      deviceId: student.deviceId,
      deviceName: device?.deviceName ?? undefined,
      studentName: student.studentName,
      classId: device?.classId || '',
      gradeLevel: student.gradeLevel ?? undefined,
      activeTabTitle,
      activeTabUrl,
      favicon,
      lastSeenAt,
      isSharing: false,
      screenLocked: false,
      flightPathActive: false,
      activeFlightPathName: undefined,
      cameraActive: false,
      status: this.calculateStatus(lastSeenAt),
    };
    this.studentStatuses.set(student.id, status);
    
    return student;
  }

  async updateStudent(studentId: string, updates: Partial<InsertStudent>): Promise<Student | undefined> {
    const [student] = await db
      .update(students)
      .set(updates)
      .where(eq(students.id, studentId))
      .returning();
    
    if (!student) return undefined;
    
    // Update status map if relevant fields changed
    const status = this.studentStatuses.get(studentId);
    if (status) {
      if (updates.studentName) {
        status.studentName = updates.studentName;
      }
      if (updates.gradeLevel !== undefined) {
        status.gradeLevel = updates.gradeLevel ?? undefined;
      }
      if (updates.deviceId) {
        status.deviceId = updates.deviceId;
        const device = await this.getDevice(updates.deviceId);
        if (device) {
          status.deviceName = device.deviceName ?? undefined;
          status.classId = device.classId;
        }
      }
      this.studentStatuses.set(studentId, status);
    }
    
    return student;
  }

  async deleteStudent(studentId: string): Promise<boolean> {
    // Delete heartbeats for this student
    await db.delete(heartbeats).where(eq(heartbeats.studentId, studentId));
    
    // Delete events for this student
    await db.delete(events).where(eq(events.studentId, studentId));
    
    // Get student to find device for active student cleanup
    const student = await this.getStudent(studentId);
    
    // Delete student
    const [deletedStudent] = await db
      .delete(students)
      .where(eq(students.id, studentId))
      .returning();
    
    // Remove from in-memory status map
    this.studentStatuses.delete(studentId);
    
    // Clear from active students if this student is active
    if (student) {
      const activeStudentId = this.activeStudents.get(student.deviceId);
      if (activeStudentId === studentId) {
        this.activeStudents.delete(student.deviceId);
      }
    }
    
    return !!deletedStudent;
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

  async getAllStudentStatuses(): Promise<StudentStatus[]> {
    const statuses = Array.from(this.studentStatuses.values());
    
    return statuses.map(status => ({
      ...status,
      status: this.calculateStatus(status.lastSeenAt),
    }));
  }

  async updateStudentStatus(status: StudentStatus): Promise<void> {
    this.studentStatuses.set(status.studentId, status);
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
  async addHeartbeat(insertHeartbeat: InsertHeartbeat): Promise<Heartbeat> {
    const [heartbeat] = await db
      .insert(heartbeats)
      .values(insertHeartbeat)
      .returning();
    
    // Update student status if studentId is provided
    if (heartbeat.studentId) {
      let status = this.studentStatuses.get(heartbeat.studentId);
      if (!status) {
        // Status missing (e.g., after restart), get student info and create
        const student = await this.getStudent(heartbeat.studentId);
        if (student) {
          const device = await this.getDevice(student.deviceId);
          status = {
            studentId: student.id,
            deviceId: student.deviceId,
            deviceName: device?.deviceName ?? undefined,
            studentName: student.studentName,
            classId: device?.classId || '',
            gradeLevel: student.gradeLevel ?? undefined,
            activeTabTitle: heartbeat.activeTabTitle,
            activeTabUrl: heartbeat.activeTabUrl,
            favicon: heartbeat.favicon ?? undefined,
            lastSeenAt: Date.now(),
            isSharing: heartbeat.isSharing ?? false,
            screenLocked: heartbeat.screenLocked ?? false,
            flightPathActive: heartbeat.flightPathActive ?? false,
            activeFlightPathName: heartbeat.activeFlightPathName || undefined,
            cameraActive: heartbeat.cameraActive ?? false,
            status: 'online',
          };
          this.studentStatuses.set(heartbeat.studentId, status);
          console.log('Created StudentStatus from DB:', { studentId: student.id, studentName: student.studentName, gradeLevel: student.gradeLevel });
        } else {
          console.warn('Heartbeat has studentId but student not found in DB:', heartbeat.studentId);
        }
      } else {
        // Update existing status
        const now = Date.now();
        status.activeTabTitle = heartbeat.activeTabTitle;
        status.activeTabUrl = heartbeat.activeTabUrl;
        status.favicon = heartbeat.favicon ?? undefined;
        
        // Only update screenLocked from heartbeat if server hasn't set it recently (within 5 seconds)
        const serverSetRecently = status.screenLockedSetAt && (now - status.screenLockedSetAt) < 5000;
        if (!serverSetRecently) {
          status.screenLocked = heartbeat.screenLocked ?? false;
        }
        
        status.isSharing = heartbeat.isSharing ?? false;
        status.flightPathActive = heartbeat.flightPathActive ?? false;
        status.activeFlightPathName = heartbeat.activeFlightPathName || undefined;
        status.cameraActive = heartbeat.cameraActive ?? false;
        status.lastSeenAt = now;
        status.status = this.calculateStatus(now);
        
        // Calculate current URL duration
        status.currentUrlDuration = await this.calculateCurrentUrlDurationDb(heartbeat.studentId, heartbeat.activeTabUrl);
        
        this.studentStatuses.set(heartbeat.studentId, status);
      }
    }
    
    return heartbeat;
  }

  // Helper function to calculate duration on current URL (DatabaseStorage)
  private async calculateCurrentUrlDurationDb(studentId: string, currentUrl: string): Promise<number> {
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

  async getAllHeartbeats(): Promise<Heartbeat[]> {
    return await db
      .select()
      .from(heartbeats)
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

  async getAllRosters(): Promise<Roster[]> {
    return await db.select().from(rosters);
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
  async getSettings(): Promise<Settings | undefined> {
    const [setting] = await db.select().from(settings).limit(1);
    return setting || undefined;
  }

  async upsertSettings(insertSettings: InsertSettings): Promise<Settings> {
    const existing = await this.getSettings();
    
    if (existing) {
      const [updated] = await db
        .update(settings)
        .set(insertSettings)
        .where(eq(settings.id, existing.id))
        .returning();
      return updated;
    } else {
      const [created] = await db
        .insert(settings)
        .values(insertSettings)
        .returning();
      return created;
    }
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
    return results.map((r) => r.studentId);
  }

  async getStudentTeachers(studentId: string): Promise<string[]> {
    const results = await db
      .select({ teacherId: teacherStudents.teacherId })
      .from(teacherStudents)
      .where(eq(teacherStudents.studentId, studentId));
    return results.map((r) => r.teacherId);
  }

  // Flight Paths
  async getFlightPath(id: string): Promise<FlightPath | undefined> {
    const [flightPath] = await db.select().from(flightPaths).where(eq(flightPaths.id, id));
    return flightPath || undefined;
  }

  async getAllFlightPaths(): Promise<FlightPath[]> {
    return await db.select().from(flightPaths);
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

  // Student Groups
  async getStudentGroup(id: string): Promise<StudentGroup | undefined> {
    const [group] = await db.select().from(studentGroups).where(eq(studentGroups.id, id));
    return group || undefined;
  }

  async getAllStudentGroups(): Promise<StudentGroup[]> {
    return await db.select().from(studentGroups);
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

  async getGroupsByTeacher(teacherId: string): Promise<Group[]> {
    return await db
      .select()
      .from(groups)
      .where(eq(groups.teacherId, teacherId))
      .orderBy(groups.createdAt);
  }

  async getAllGroups(): Promise<Group[]> {
    return await db.select().from(groups).orderBy(groups.createdAt);
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
    return results.map(r => r.studentId);
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
    return results.map(r => r.groupId);
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

  async getActiveSessions(): Promise<Session[]> {
    return await db
      .select()
      .from(sessions)
      .where(drizzleSql`${sessions.endTime} IS NULL`)
      .orderBy(desc(sessions.startTime));
  }

  async getAllSessions(): Promise<Session[]> {
    return await db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.startTime));
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
}

// Export storage instance based on environment
export const storage: IStorage = process.env.DATABASE_URL 
  ? new DatabaseStorage() 
  : new MemStorage();

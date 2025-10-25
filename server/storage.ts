import {
  type User,
  type InsertUser,
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
  users,
  students,
  heartbeats,
  events,
  rosters,
  settings,
} from "@shared/schema";
import { randomUUID } from "crypto";
import { db } from "./db";
import { eq, desc, lt, sql as drizzleSql } from "drizzle-orm";

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getAllUsers(): Promise<User[]>;
  deleteUser(id: string): Promise<boolean>;

  // Students
  getStudent(deviceId: string): Promise<Student | undefined>;
  getAllStudents(): Promise<Student[]>;
  registerStudent(student: InsertStudent): Promise<Student>;

  // Student Status (in-memory tracking)
  getStudentStatus(deviceId: string): Promise<StudentStatus | undefined>;
  getAllStudentStatuses(): Promise<StudentStatus[]>;
  updateStudentStatus(status: StudentStatus): Promise<void>;

  // Heartbeats
  addHeartbeat(heartbeat: InsertHeartbeat): Promise<Heartbeat>;
  getHeartbeatsByDevice(deviceId: string, limit?: number): Promise<Heartbeat[]>;
  getAllHeartbeats(): Promise<Heartbeat[]>;
  cleanupOldHeartbeats(retentionHours: number): Promise<number>;

  // Events
  addEvent(event: InsertEvent): Promise<Event>;
  getEventsByDevice(deviceId: string): Promise<Event[]>;

  // Rosters
  getRoster(classId: string): Promise<Roster | undefined>;
  getAllRosters(): Promise<Roster[]>;
  upsertRoster(roster: InsertRoster): Promise<Roster>;

  // Settings
  getSettings(): Promise<Settings | undefined>;
  upsertSettings(settings: InsertSettings): Promise<Settings>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private students: Map<string, Student>;
  private studentStatuses: Map<string, StudentStatus>;
  private heartbeats: Heartbeat[];
  private events: Event[];
  private rosters: Map<string, Roster>;
  private settings: Settings | undefined;

  constructor() {
    this.users = new Map();
    this.students = new Map();
    this.studentStatuses = new Map();
    this.heartbeats = [];
    this.events = [];
    this.rosters = new Map();
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

  // Students
  async getStudent(deviceId: string): Promise<Student | undefined> {
    return this.students.get(deviceId);
  }

  async getAllStudents(): Promise<Student[]> {
    return Array.from(this.students.values());
  }

  async registerStudent(insertStudent: InsertStudent): Promise<Student> {
    const student: Student = {
      ...insertStudent,
      registeredAt: new Date(),
    };
    this.students.set(student.deviceId, student);
    
    // Initialize status
    const status: StudentStatus = {
      deviceId: student.deviceId,
      studentName: student.studentName,
      classId: student.classId,
      activeTabTitle: "",
      activeTabUrl: "",
      lastSeenAt: Date.now(),
      isSharing: false,
      status: 'offline',
    };
    this.studentStatuses.set(student.deviceId, status);
    
    return student;
  }

  // Student Status
  async getStudentStatus(deviceId: string): Promise<StudentStatus | undefined> {
    return this.studentStatuses.get(deviceId);
  }

  async getAllStudentStatuses(): Promise<StudentStatus[]> {
    const now = Date.now();
    const statuses = Array.from(this.studentStatuses.values());
    
    // Update status based on last seen time
    return statuses.map(status => {
      const timeSinceLastSeen = now - status.lastSeenAt;
      let newStatus: 'online' | 'idle' | 'offline' = 'offline';
      
      if (timeSinceLastSeen < 30000) { // Less than 30 seconds
        newStatus = 'online';
      } else if (timeSinceLastSeen < 120000) { // Less than 2 minutes
        newStatus = 'idle';
      } else {
        newStatus = 'offline';
      }
      
      return {
        ...status,
        status: newStatus,
      };
    });
  }

  async updateStudentStatus(status: StudentStatus): Promise<void> {
    this.studentStatuses.set(status.deviceId, status);
  }

  // Heartbeats
  async addHeartbeat(insertHeartbeat: InsertHeartbeat): Promise<Heartbeat> {
    const heartbeat: Heartbeat = {
      ...insertHeartbeat,
      id: randomUUID(),
      timestamp: new Date(),
    };
    this.heartbeats.push(heartbeat);
    
    // Update student status
    const status = this.studentStatuses.get(heartbeat.deviceId);
    if (status) {
      status.activeTabTitle = heartbeat.activeTabTitle;
      status.activeTabUrl = heartbeat.activeTabUrl;
      status.favicon = heartbeat.favicon;
      status.lastSeenAt = Date.now();
      this.studentStatuses.set(heartbeat.deviceId, status);
    }
    
    return heartbeat;
  }

  async getHeartbeatsByDevice(deviceId: string, limit: number = 20): Promise<Heartbeat[]> {
    return this.heartbeats
      .filter((h) => h.deviceId === deviceId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }

  async getAllHeartbeats(): Promise<Heartbeat[]> {
    return this.heartbeats.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  async cleanupOldHeartbeats(retentionHours: number): Promise<number> {
    const cutoffTime = Date.now() - retentionHours * 60 * 60 * 1000;
    const initialCount = this.heartbeats.length;
    
    this.heartbeats = this.heartbeats.filter(
      (h) => new Date(h.timestamp).getTime() > cutoffTime
    );
    
    return initialCount - this.heartbeats.length;
  }

  // Events
  async addEvent(insertEvent: InsertEvent): Promise<Event> {
    const event: Event = {
      ...insertEvent,
      id: randomUUID(),
      timestamp: new Date(),
    };
    this.events.push(event);
    return event;
  }

  async getEventsByDevice(deviceId: string): Promise<Event[]> {
    return this.events
      .filter((e) => e.deviceId === deviceId)
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
      ...insertRoster,
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
      ...insertSettings,
    };
    this.settings = settings;
    return settings;
  }
}

// Database storage implementation
export class DatabaseStorage implements IStorage {
  private studentStatuses: Map<string, StudentStatus>;

  constructor() {
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
    const allStudents = await this.getAllStudents();
    for (const student of allStudents) {
      // Get most recent heartbeat to restore actual last seen time
      const recentHeartbeats = await this.getHeartbeatsByDevice(student.deviceId, 1);
      const lastHeartbeat = recentHeartbeats[0];
      
      let lastSeenAt = 0; // Default to long ago if no heartbeat
      let activeTabTitle = "";
      let activeTabUrl = "";
      let favicon: string | undefined = undefined;
      
      if (lastHeartbeat) {
        lastSeenAt = new Date(lastHeartbeat.timestamp).getTime();
        activeTabTitle = lastHeartbeat.activeTabTitle;
        activeTabUrl = lastHeartbeat.activeTabUrl;
        favicon = lastHeartbeat.favicon ?? undefined;
      }
      
      const status: StudentStatus = {
        deviceId: student.deviceId,
        studentName: student.studentName,
        classId: student.classId,
        activeTabTitle,
        activeTabUrl,
        favicon,
        lastSeenAt,
        isSharing: false,
        status: this.calculateStatus(lastSeenAt),
      };
      this.studentStatuses.set(student.deviceId, status);
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

  // Students
  async getStudent(deviceId: string): Promise<Student | undefined> {
    const [student] = await db.select().from(students).where(eq(students.deviceId, deviceId));
    return student || undefined;
  }

  async getAllStudents(): Promise<Student[]> {
    return await db.select().from(students);
  }

  async registerStudent(insertStudent: InsertStudent): Promise<Student> {
    // Upsert student (insert or update if exists)
    const [student] = await db
      .insert(students)
      .values(insertStudent)
      .onConflictDoUpdate({
        target: students.deviceId,
        set: {
          studentName: insertStudent.studentName,
          classId: insertStudent.classId,
          schoolId: insertStudent.schoolId,
        },
      })
      .returning();
    
    // Get most recent heartbeat to initialize status with real data
    const recentHeartbeats = await this.getHeartbeatsByDevice(student.deviceId, 1);
    const lastHeartbeat = recentHeartbeats[0];
    
    let lastSeenAt = 0; // Default to offline if no heartbeat yet
    let activeTabTitle = "";
    let activeTabUrl = "";
    let favicon: string | undefined = undefined;
    
    if (lastHeartbeat) {
      lastSeenAt = new Date(lastHeartbeat.timestamp).getTime();
      activeTabTitle = lastHeartbeat.activeTabTitle;
      activeTabUrl = lastHeartbeat.activeTabUrl;
      favicon = lastHeartbeat.favicon ?? undefined;
    }
    
    // Initialize/update status with real or default data
    const status: StudentStatus = {
      deviceId: student.deviceId,
      studentName: student.studentName,
      classId: student.classId,
      activeTabTitle,
      activeTabUrl,
      favicon,
      lastSeenAt,
      isSharing: false,
      status: this.calculateStatus(lastSeenAt),
    };
    this.studentStatuses.set(student.deviceId, status);
    
    return student;
  }

  // Student Status (in-memory tracking)
  async getStudentStatus(deviceId: string): Promise<StudentStatus | undefined> {
    const status = this.studentStatuses.get(deviceId);
    if (!status) return undefined;
    
    // Recalculate status based on current time for consistency
    return {
      ...status,
      status: this.calculateStatus(status.lastSeenAt),
    };
  }

  async getAllStudentStatuses(): Promise<StudentStatus[]> {
    const now = Date.now();
    const statuses = Array.from(this.studentStatuses.values());
    
    return statuses.map(status => {
      const timeSinceLastSeen = now - status.lastSeenAt;
      let newStatus: 'online' | 'idle' | 'offline' = 'offline';
      
      if (timeSinceLastSeen < 30000) {
        newStatus = 'online';
      } else if (timeSinceLastSeen < 120000) {
        newStatus = 'idle';
      } else {
        newStatus = 'offline';
      }
      
      return {
        ...status,
        status: newStatus,
      };
    });
  }

  async updateStudentStatus(status: StudentStatus): Promise<void> {
    this.studentStatuses.set(status.deviceId, status);
  }

  // Heartbeats
  async addHeartbeat(insertHeartbeat: InsertHeartbeat): Promise<Heartbeat> {
    const [heartbeat] = await db
      .insert(heartbeats)
      .values(insertHeartbeat)
      .returning();
    
    // Get or create status entry
    let status = this.studentStatuses.get(heartbeat.deviceId);
    if (!status) {
      // Status missing (e.g., after restart), get student info and create
      const student = await this.getStudent(heartbeat.deviceId);
      if (student) {
        status = {
          deviceId: student.deviceId,
          studentName: student.studentName,
          classId: student.classId,
          activeTabTitle: "",
          activeTabUrl: "",
          lastSeenAt: Date.now(),
          isSharing: false,
          status: 'online', // Will be recalculated below
        };
      }
    }
    
    if (status) {
      const now = Date.now();
      status.activeTabTitle = heartbeat.activeTabTitle;
      status.activeTabUrl = heartbeat.activeTabUrl;
      status.favicon = heartbeat.favicon ?? undefined;
      status.lastSeenAt = now;
      status.status = this.calculateStatus(now); // Recalculate status
      this.studentStatuses.set(heartbeat.deviceId, status);
    }
    
    return heartbeat;
  }

  async getHeartbeatsByDevice(deviceId: string, limit: number = 20): Promise<Heartbeat[]> {
    return await db
      .select()
      .from(heartbeats)
      .where(eq(heartbeats.deviceId, deviceId))
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
    const allSettings = await db.select().from(settings).limit(1);
    return allSettings[0] || undefined;
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
}

export const storage = new DatabaseStorage();

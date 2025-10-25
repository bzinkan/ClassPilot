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
} from "@shared/schema";
import { randomUUID } from "crypto";

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

export const storage = new MemStorage();

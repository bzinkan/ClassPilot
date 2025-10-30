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
  type Scene,
  type InsertScene,
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
  scenes,
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

  // Scenes
  getScene(id: string): Promise<Scene | undefined>;
  getAllScenes(): Promise<Scene[]>;
  createScene(scene: InsertScene): Promise<Scene>;
  updateScene(id: string, updates: Partial<InsertScene>): Promise<Scene | undefined>;
  deleteScene(id: string): Promise<boolean>;

  // Student Groups
  getStudentGroup(id: string): Promise<StudentGroup | undefined>;
  getAllStudentGroups(): Promise<StudentGroup[]>;
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
  private scenes: Map<string, Scene>;
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
    this.scenes = new Map();
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
      isSharing: insertHeartbeat.isSharing ?? false,
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
        status.screenLocked = heartbeat.screenLocked ?? false;
        status.isSharing = heartbeat.isSharing ?? false;
        status.lastSeenAt = now;
        status.status = this.calculateStatus(now);
        this.studentStatuses.set(heartbeat.studentId, status);
      }
    }
    
    return heartbeat;
  }

  async getHeartbeatsByDevice(deviceId: string, limit: number = 20): Promise<Heartbeat[]> {
    return this.heartbeats
      .filter(h => h.deviceId === deviceId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }

  async getHeartbeatsByStudent(studentId: string, limit: number = 20): Promise<Heartbeat[]> {
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
      activeSceneId: insertSettings.activeSceneId ?? null,
    };
    this.settings = settings;
    return settings;
  }

  // Scenes
  async getScene(id: string): Promise<Scene | undefined> {
    return this.scenes.get(id);
  }

  async getAllScenes(): Promise<Scene[]> {
    return Array.from(this.scenes.values());
  }

  async createScene(insertScene: InsertScene): Promise<Scene> {
    const id = randomUUID();
    const scene: Scene = {
      id,
      schoolId: insertScene.schoolId,
      sceneName: insertScene.sceneName,
      description: insertScene.description ?? null,
      allowedDomains: insertScene.allowedDomains ?? null,
      blockedDomains: insertScene.blockedDomains ?? null,
      isDefault: insertScene.isDefault ?? false,
      createdAt: new Date(),
    };
    this.scenes.set(id, scene);
    return scene;
  }

  async updateScene(id: string, updates: Partial<InsertScene>): Promise<Scene | undefined> {
    const existing = this.scenes.get(id);
    if (!existing) return undefined;

    const updated: Scene = {
      ...existing,
      ...updates,
    };
    this.scenes.set(id, updated);
    return updated;
  }

  async deleteScene(id: string): Promise<boolean> {
    return this.scenes.delete(id);
  }

  // Student Groups
  async getStudentGroup(id: string): Promise<StudentGroup | undefined> {
    return this.studentGroups.get(id);
  }

  async getAllStudentGroups(): Promise<StudentGroup[]> {
    return Array.from(this.studentGroups.values());
  }

  async createStudentGroup(insertGroup: InsertStudentGroup): Promise<StudentGroup> {
    const id = randomUUID();
    const group: StudentGroup = {
      id,
      schoolId: insertGroup.schoolId,
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
        status.screenLocked = heartbeat.screenLocked ?? false;
        status.isSharing = heartbeat.isSharing ?? false;
        status.lastSeenAt = now;
        status.status = this.calculateStatus(now);
        this.studentStatuses.set(heartbeat.studentId, status);
      }
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

  async getHeartbeatsByStudent(studentId: string, limit: number = 20): Promise<Heartbeat[]> {
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

  // Scenes
  async getScene(id: string): Promise<Scene | undefined> {
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, id));
    return scene || undefined;
  }

  async getAllScenes(): Promise<Scene[]> {
    return await db.select().from(scenes);
  }

  async createScene(insertScene: InsertScene): Promise<Scene> {
    const [created] = await db
      .insert(scenes)
      .values(insertScene)
      .returning();
    return created;
  }

  async updateScene(id: string, updates: Partial<InsertScene>): Promise<Scene | undefined> {
    const [updated] = await db
      .update(scenes)
      .set(updates)
      .where(eq(scenes.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteScene(id: string): Promise<boolean> {
    const result = await db.delete(scenes).where(eq(scenes.id, id));
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
}

// Export storage instance based on environment
export const storage: IStorage = process.env.DATABASE_URL 
  ? new DatabaseStorage() 
  : new MemStorage();

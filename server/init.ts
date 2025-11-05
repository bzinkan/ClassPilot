import { storage } from "./storage";
import bcrypt from "bcrypt";

export async function initializeApp() {
  // Create default admin account if none exists
  const existingAdmin = await storage.getUserByUsername("admin");
  
  if (!existingAdmin) {
    const hashedPassword = await bcrypt.hash("admin123", 10);
    await storage.createUser({
      username: "admin",
      password: hashedPassword,
      role: "admin",
      schoolName: "Default School",
    });
    console.log("Created default admin account: username='admin', password='admin123'");
    console.log("⚠️  IMPORTANT: Change this password in production!");
  }
  
  // Create default teacher account if none exists
  const existingTeacher = await storage.getUserByUsername("teacher");
  
  if (!existingTeacher) {
    const hashedPassword = await bcrypt.hash("teacher123", 10);
    await storage.createUser({
      username: "teacher",
      password: hashedPassword,
      role: "teacher",
      schoolName: "Default School",
    });
    console.log("Created default teacher account: username='teacher', password='teacher123'");
    console.log("⚠️  IMPORTANT: Change this password in production!");
  }

  // Create default settings
  const existingSettings = await storage.getSettings();
  if (!existingSettings) {
    await storage.upsertSettings({
      schoolId: process.env.SCHOOL_ID || "default-school",
      schoolName: "Default School",
      wsSharedKey: process.env.WS_SHARED_KEY || "change-this-websocket-key",
      retentionHours: "24",
      blockedDomains: [],
    });
    console.log("Created default settings");
  }

  // Migrate existing data: assign all students to the default teacher
  const teacherUser = await storage.getUserByUsername("teacher");
  if (teacherUser) {
    const allStudents = await storage.getAllStudents();
    const teacherStudentIds = await storage.getTeacherStudents(teacherUser.id);
    
    // Assign any unassigned students to the default teacher
    for (const student of allStudents) {
      if (!teacherStudentIds.includes(student.id)) {
        await storage.assignStudentToTeacher(teacherUser.id, student.id);
      }
    }
    
    // Update existing flight paths without teacherId
    const allFlightPaths = await storage.getAllFlightPaths();
    const orphanedFlightPaths = allFlightPaths.filter(fp => fp.teacherId === null && !fp.isDefault);
    
    for (const fp of orphanedFlightPaths) {
      await storage.updateFlightPath(fp.id, { teacherId: teacherUser.id });
    }
    
    // Update existing student groups without teacherId
    const allGroups = await storage.getAllStudentGroups();
    const orphanedGroups = allGroups.filter(g => g.teacherId === null);
    
    for (const group of orphanedGroups) {
      await storage.updateStudentGroup(group.id, { teacherId: teacherUser.id });
    }
    
    if (allStudents.length > 0 && teacherStudentIds.length === 0) {
      console.log(`Migrated ${allStudents.length} students to default teacher`);
    }
    if (orphanedFlightPaths.length > 0) {
      console.log(`Migrated ${orphanedFlightPaths.length} flight paths to default teacher`);
    }
    if (orphanedGroups.length > 0) {
      console.log(`Migrated ${orphanedGroups.length} student groups to default teacher`);
    }
  }

  // Rehydrate student statuses from database (for DatabaseStorage)
  if ('rehydrateStatuses' in storage) {
    await (storage as any).rehydrateStatuses();
  }
}

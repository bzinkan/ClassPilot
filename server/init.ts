import { storage } from "./storage";
import bcrypt from "bcrypt";

export async function initializeApp() {
  const isProduction = process.env.NODE_ENV === "production";
  const seedDemoUsersEnv = process.env.SEED_DEMO_USERS;
  const seedDemoUsers = seedDemoUsersEnv === "true";
  const shouldSeedDemoUsers = !isProduction && (seedDemoUsers || seedDemoUsersEnv === undefined);

  if (isProduction && seedDemoUsers) {
    console.warn("⚠️  SEED_DEMO_USERS=true ignored in production - demo users will not be created.");
  }

  if (shouldSeedDemoUsers) {
    console.log("🔧 Seeding demo users (non-production environment).");
  }

  // Create super admin account from environment variable if none exists
  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL;
  
  if (superAdminEmail) {
    const existingSuperAdmin = await storage.getUserByEmail(superAdminEmail);
    
    if (!existingSuperAdmin) {
      // Create super admin account without password (Google OAuth only)
      await storage.createUser({
        email: superAdminEmail,
        password: null, // No password - Google OAuth only
        role: "super_admin",
        schoolId: null, // Super admins are not tied to any school
        displayName: superAdminEmail.split('@')[0],
      });
      console.log(`✅ Created super admin account: ${superAdminEmail}`);
      console.log("   Sign in at /login using 'Sign in with Google'");
    }
  } else {
    console.log("⚠️  No SUPER_ADMIN_EMAIL set - super admin account not created");
  }
  
  if (shouldSeedDemoUsers) {
    // Create default admin account if none exists (legacy - for backward compatibility)
    const existingAdmin = await storage.getUserByUsername("admin");
    
    if (!existingAdmin) {
      const hashedPassword = await bcrypt.hash("admin123", 10);
      await storage.createUser({
        username: "admin",
        email: "admin@localhost",
        password: hashedPassword,
        role: "admin",
        schoolName: "Default School",
      });
      console.log("Created default admin account: username='admin', password='admin123'");
      console.log("⚠️  IMPORTANT: Change this password in production!");
    }
    
    // Create default teacher account if none exists (legacy - for backward compatibility)
    const existingTeacher = await storage.getUserByUsername("teacher");
    
    if (!existingTeacher) {
      const hashedPassword = await bcrypt.hash("teacher123", 10);
      await storage.createUser({
        username: "teacher",
        email: "teacher@localhost",
        password: hashedPassword,
        role: "teacher",
        schoolName: "Default School",
      });
      console.log("Created default teacher account: username='teacher', password='teacher123'");
      console.log("⚠️  IMPORTANT: Change this password in production!");
    }
  }

  // Create default settings
  const defaultSchoolId = process.env.SCHOOL_ID || "default-school";
  const existingSettings = await storage.getSettingsBySchoolId(defaultSchoolId);
  if (!existingSettings) {
    await storage.upsertSettingsForSchool(defaultSchoolId, {
      schoolName: "Default School",
      wsSharedKey: process.env.WS_SHARED_KEY || "change-this-key",
      retentionHours: "24",
      blockedDomains: [],
    });
    console.log("Created default settings");
  }

  // Migrate existing data: assign all students to the default teacher
  // Only assign students that have NO teacher at all (don't overwrite existing assignments)
  const teacherUser = await storage.getUserByUsername("teacher");
  if (teacherUser) {
    const settings = existingSettings ?? await storage.getSettingsBySchoolId(defaultSchoolId);
    const teacherSchoolId = teacherUser.schoolId ?? settings?.schoolId ?? defaultSchoolId;

    const allStudents = await storage.getStudentsBySchool(teacherSchoolId);
    
    // Get all teachers to check existing assignments
    const allUsers = await storage.getUsersBySchool(teacherSchoolId);
    const teacherIds = allUsers.filter(u => u.role === 'teacher').map(u => u.id);
    
    // Find students that have NO teacher at all
    const studentsWithoutTeacher = [];
    for (const student of allStudents) {
      let hasTeacher = false;
      for (const teacherId of teacherIds) {
        const teacherStudents = await storage.getTeacherStudents(teacherId);
        if (teacherStudents.includes(student.id)) {
          hasTeacher = true;
          break;
        }
      }
      if (!hasTeacher) {
        studentsWithoutTeacher.push(student);
      }
    }
    
    // Assign unowned students to the default teacher
    for (const student of studentsWithoutTeacher) {
      await storage.assignStudentToTeacher(teacherUser.id, student.id);
    }
    
    // Update existing flight paths without teacherId
    const allFlightPaths = await storage.getFlightPathsBySchool(teacherSchoolId);
    const orphanedFlightPaths = allFlightPaths.filter(fp => fp.teacherId === null && !fp.isDefault);
    
    for (const fp of orphanedFlightPaths) {
      await storage.updateFlightPath(fp.id, { teacherId: teacherUser.id });
    }
    
    // Update existing student groups without teacherId
    const allGroups = await storage.getStudentGroupsBySchool(teacherSchoolId);
    const orphanedGroups = allGroups.filter(g => g.teacherId === null);
    
    for (const group of orphanedGroups) {
      await storage.updateStudentGroup(group.id, { teacherId: teacherUser.id });
    }
    
    if (studentsWithoutTeacher.length > 0) {
      console.log(`Assigned ${studentsWithoutTeacher.length} unowned students to default teacher`);
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

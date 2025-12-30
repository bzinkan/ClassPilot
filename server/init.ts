import { storage } from "./storage";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { requireEnv } from "./util/requireEnv";
import { generateSecurePassword } from "./util/password";

export async function initializeApp() {
  const isProduction = process.env.NODE_ENV === "production";

  // Generate secure WebSocket key if not provided
  let wsSharedKey: string;
  if (isProduction) {
    wsSharedKey = requireEnv("WS_SHARED_KEY");
  } else {
    if (process.env.WS_SHARED_KEY) {
      wsSharedKey = process.env.WS_SHARED_KEY;
    } else {
      // Generate cryptographically secure random key for development
      wsSharedKey = crypto.randomBytes(32).toString("base64");
      console.log("[dev] Generated random WS_SHARED_KEY for this session");
    }
  }
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
      // Generate secure random password for demo admin
      const demoAdminPassword = generateSecurePassword(12);
      const hashedPassword = await bcrypt.hash(demoAdminPassword, 10);
      await storage.createUser({
        username: "admin",
        email: "admin@localhost",
        password: hashedPassword,
        role: "admin",
        schoolName: "Default School",
      });
      console.log("✅ Created demo admin account: username='admin'");
      console.log(`   Password: ${demoAdminPassword}`);
      console.log("   ⚠️  Save this password - it will not be shown again!");
    }
    
    // Create default teacher account if none exists (legacy - for backward compatibility)
    const existingTeacher = await storage.getUserByUsername("teacher");

    if (!existingTeacher) {
      // Generate secure random password for demo teacher
      const demoTeacherPassword = generateSecurePassword(12);
      const hashedPassword = await bcrypt.hash(demoTeacherPassword, 10);
      await storage.createUser({
        username: "teacher",
        email: "teacher@localhost",
        password: hashedPassword,
        role: "teacher",
        schoolName: "Default School",
      });
      console.log("✅ Created demo teacher account: username='teacher'");
      console.log(`   Password: ${demoTeacherPassword}`);
      console.log("   ⚠️  Save this password - it will not be shown again!");
    }
  }

  // Create default settings
  const defaultSchoolId = process.env.SCHOOL_ID || "default-school";
  const existingSettings = await storage.getSettingsBySchoolId(defaultSchoolId);
  if (!existingSettings) {
    await storage.upsertSettingsForSchool(defaultSchoolId, {
      schoolName: "Default School",
      wsSharedKey,
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

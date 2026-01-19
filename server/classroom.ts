import { google } from "googleapis";
import { storage } from "./storage";
import { getBaseUrl } from "./config/baseUrl";

// Timeout wrapper for API calls
const API_TIMEOUT_MS = 30000; // 30 seconds

function withTimeout<T>(promise: Promise<T>, timeoutMs: number = API_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`API call timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

// Helper to get an authenticated Classroom client for a user
export async function getClassroomClient(userId: string) {
  // 1. Get tokens from DB
  const tokens = await storage.getGoogleOAuthTokens(userId);
  if (!tokens || !tokens.refreshToken) {
    throw new Error("No Google Classroom tokens found. Please reconnect your account.");
  }

  // 2. Create OAuth2 client
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    // Ensure this matches the callback URL in your googleAuth.ts
    `${getBaseUrl()}/auth/google/callback`
  );

  // 3. Set credentials
  oauth2Client.setCredentials({
    refresh_token: tokens.refreshToken,
    scope: tokens.scope,
    token_type: tokens.tokenType || "Bearer",
    expiry_date: tokens.expiryDate ? new Date(tokens.expiryDate).getTime() : undefined,
  });

  // 4. Return Classroom API instance
  return google.classroom({ version: "v1", auth: oauth2Client });
}

export async function syncCourses(userId: string, schoolId: string) {
  const classroom = await getClassroomClient(userId);

  // Fetch active courses where the user is a teacher (with timeout)
  const response = await withTimeout(
    classroom.courses.list({
      teacherId: "me",
      courseStates: ["ACTIVE"],
    }) as Promise<any>
  );

  const courses = response.data.courses || [];

  // Save to DB
  for (const course of courses) {
    if (course.id && course.name) {
      await storage.upsertClassroomCourse({
        schoolId,
        courseId: course.id,
        name: course.name,
        section: course.section || null,
        room: course.room || null,
        descriptionHeading: course.descriptionHeading || null,
        ownerId: course.ownerId || null,
        lastSyncedAt: new Date(),
      });
    }
  }

  return courses;
}

export async function syncRoster(
  userId: string,
  schoolId: string,
  courseId: string,
  options: { gradeLevel?: string } = {}
) {
  const classroom = await getClassroomClient(userId);

  // Fetch students (with timeout)
  const response = await withTimeout(
    classroom.courses.students.list({
      courseId,
    }) as Promise<any>
  );

  const students = response.data.students || [];
  const studentEntries = [];

  // Process students
  for (const student of students) {
    const profile = student.profile;
    const email = profile?.emailAddress;

    if (!email) continue; // Skip if no email

    // We normalize email to ensure consistent lookup
    const emailLc = email.toLowerCase();

    // 1. Ensure student exists in our global students table (Email-First Identity)
    let dbStudent = await storage.getStudentBySchoolEmail(schoolId, emailLc);

    if (!dbStudent) {
      // Auto-provision student if they don't exist
      console.log(`[Sync] Auto-provisioning student from Classroom: ${email}`);
      dbStudent = await storage.createStudent({
        studentName: profile?.name?.fullName || email.split("@")[0],
        studentEmail: email,
        emailLc: emailLc,
        googleUserId: profile?.id,
        schoolId,
        studentStatus: "active",
        deviceId: null, // Device ID will be linked when they sign in via extension
        gradeLevel: options.gradeLevel || undefined,
      });
    } else {
      // Update existing student with Google User ID if missing, and grade level if provided
      const updateData: { googleUserId?: string; gradeLevel?: string } = {};
      if (!dbStudent.googleUserId && profile?.id) {
        updateData.googleUserId = profile.id;
      }
      if (options.gradeLevel) {
        updateData.gradeLevel = options.gradeLevel;
      }
      if (Object.keys(updateData).length > 0) {
        await storage.updateStudent(dbStudent.id, updateData);
      }
    }

    // 2. Prepare entry for roster join table
    studentEntries.push({
      studentId: dbStudent.id,
      googleUserId: profile?.id,
      studentEmailLc: emailLc,
    });
  }

  // Replace old roster with new one
  await storage.replaceCourseStudents(schoolId, courseId, studentEntries);

  return studentEntries;
}

import { google } from "googleapis";
import { storage } from "./storage";

interface DirectoryUser {
  id: string;
  email: string;
  name: string;
  orgUnitPath?: string;
  isAdmin?: boolean;
  suspended?: boolean;
}

type GoogleRefreshTokens = {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  token_type?: string | null;
  scope?: string | null;
};

interface DirectoryUsersResponse {
  users: DirectoryUser[];
  nextPageToken?: string;
}

async function getAuthClient(userId: string) {
  const tokens = await storage.getGoogleOAuthTokens(userId);
  if (!tokens) {
    const error: any = new Error("No Google OAuth tokens found. Please reconnect your Google account.");
    error.code = "NO_TOKENS";
    throw error;
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: tokens.refreshToken,
    token_type: tokens.tokenType ?? "Bearer",
    scope: tokens.scope ?? undefined,
    expiry_date: tokens.expiryDate ? tokens.expiryDate.getTime() : undefined,
  });

  oauth2Client.on("tokens", async (newTokens: GoogleRefreshTokens) => {
    try {
      await storage.upsertGoogleOAuthTokens(userId, {
        refreshToken: newTokens.refresh_token || tokens.refreshToken,
        expiryDate: newTokens.expiry_date ? new Date(newTokens.expiry_date) : tokens.expiryDate ?? undefined,
        tokenType: newTokens.token_type || tokens.tokenType || "Bearer",
        scope: tokens.scope ?? undefined,
      });
    } catch (err) {
      console.error("Failed to save refreshed tokens:", err);
    }
  });

  return oauth2Client;
}

export async function listDomainUsers(
  userId: string,
  domain?: string,
  query?: string,
  maxResults: number = 500
): Promise<DirectoryUsersResponse> {
  try {
    const auth = await getAuthClient(userId);
    const admin = google.admin({ version: "directory_v1", auth });

    const params: any = {
      customer: "my_customer",
      maxResults: Math.min(maxResults, 500),
      orderBy: "email",
    };

    if (domain) {
      params.domain = domain;
    }

    if (query) {
      params.query = query;
    }

    const response = await admin.users.list(params);

    const users: DirectoryUser[] = (response.data.users || []).map((user: any) => ({
      id: user.id,
      email: user.primaryEmail,
      name: user.name?.fullName || user.primaryEmail?.split("@")[0] || "Unknown",
      orgUnitPath: user.orgUnitPath,
      isAdmin: user.isAdmin || false,
      suspended: user.suspended || false,
    }));

    return {
      users,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  } catch (error: any) {
    console.error("Google Admin Directory API error:", error.message);
    
    if (error.code === "NO_TOKENS") {
      throw error;
    }
    
    if (error.code === 403) {
      const authError: any = new Error(
        "You don't have permission to access the Admin Directory. This feature requires Google Workspace admin privileges."
      );
      authError.code = "INSUFFICIENT_PERMISSIONS";
      throw authError;
    }
    
    if (error.code === 401) {
      const authError: any = new Error(
        "Google authentication expired. Please sign out and sign back in."
      );
      authError.code = "AUTH_EXPIRED";
      throw authError;
    }
    
    throw new Error(`Failed to fetch users from Google Workspace: ${error.message}`);
  }
}

/** Attempt to detect a grade level from an OU name string */
export function detectGradeFromName(name: string): string | null {
  const n = name.trim();

  // Pre-K variants
  if (/^pre[- ]?k(indergarten)?$/i.test(n)) return "PK";

  // Kindergarten variants
  if (/^(kindergarten|kinder|k)$/i.test(n)) return "K";

  // "Grade 3", "Grade 03"
  const gradeNum = n.match(/^grade\s+0?(\d{1,2})$/i);
  if (gradeNum) {
    const g = parseInt(gradeNum[1], 10);
    if (g >= 1 && g <= 12) return String(g);
  }

  // "3rd Grade", "1st Grade", "11th Grade"
  const ordinalGrade = n.match(/^0?(\d{1,2})(?:st|nd|rd|th)\s+grade$/i);
  if (ordinalGrade) {
    const g = parseInt(ordinalGrade[1], 10);
    if (g >= 1 && g <= 12) return String(g);
  }

  // "First Grade" through "Twelfth Grade"
  const wordMap: Record<string, string> = {
    first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6",
    seventh: "7", eighth: "8", ninth: "9", tenth: "10", eleventh: "11", twelfth: "12",
  };
  const wordGrade = n.match(/^(\w+)\s+grade$/i);
  if (wordGrade && wordMap[wordGrade[1].toLowerCase()]) {
    return wordMap[wordGrade[1].toLowerCase()];
  }

  // Bare ordinal: "3rd", "5th"
  const bareOrdinal = n.match(/^0?(\d{1,2})(?:st|nd|rd|th)$/i);
  if (bareOrdinal) {
    const g = parseInt(bareOrdinal[1], 10);
    if (g >= 1 && g <= 12) return String(g);
  }

  return null;
}

export interface EnrichedOrgUnit {
  orgUnitPath: string;
  orgUnitId: string;
  name: string;
  description?: string;
  parentOrgUnitPath?: string;
  detectedGrade: string | null;
}

export async function getOrganizationUnits(userId: string): Promise<EnrichedOrgUnit[]> {
  try {
    const auth = await getAuthClient(userId);
    const admin = google.admin({ version: "directory_v1", auth });

    const response = await admin.orgunits.list({
      customerId: "my_customer",
      type: "all",
    });

    const orgUnits = response.data.organizationUnits || [];
    return orgUnits.map((ou: any) => ({
      orgUnitPath: ou.orgUnitPath,
      orgUnitId: ou.orgUnitId,
      name: ou.name,
      description: ou.description,
      parentOrgUnitPath: ou.parentOrgUnitPath,
      detectedGrade: detectGradeFromName(ou.name),
    }));
  } catch (error: any) {
    console.error("Failed to fetch org units:", error.message);
    return [];
  }
}

export async function importStudentsFromDirectory(
  userId: string,
  schoolId: string,
  options: {
    domain?: string;
    orgUnitPath?: string;
    includeStudentsOnly?: boolean;
    gradeLevel?: string;
    excludeEmails?: string[];
  } = {}
): Promise<{
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}> {
  const result = {
    imported: 0,
    updated: 0,
    skipped: 0,
    errors: [] as string[],
  };

  try {
    let query = "";

    if (options.orgUnitPath) {
      query = `orgUnitPath='${options.orgUnitPath}'`;
    }

    const { users } = await listDomainUsers(userId, options.domain, query);

    const excludeSet = new Set((options.excludeEmails || []).map(e => e.toLowerCase()));
    const activeUsers = users.filter((u) => !u.suspended && !u.isAdmin && !excludeSet.has(u.email.toLowerCase()));

    for (const user of activeUsers) {
      try {
        const existingStudent = await storage.getStudentBySchoolEmail(
          schoolId,
          user.email.toLowerCase()
        );

        if (existingStudent) {
          const updateData: { studentName: string; gradeLevel?: string } = {
            studentName: user.name,
          };
          if (options.gradeLevel) {
            updateData.gradeLevel = options.gradeLevel;
          }
          await storage.updateStudent(existingStudent.id, updateData);
          result.updated++;
        } else {
          await storage.createStudent({
            studentEmail: user.email,
            studentName: user.name,
            schoolId,
            studentStatus: "active",
            emailLc: user.email.toLowerCase(),
            gradeLevel: options.gradeLevel || undefined,
          });
          result.imported++;
        }
      } catch (err: any) {
        result.errors.push(`Failed to import ${user.email}: ${err.message}`);
      }
    }

    return result;
  } catch (error: any) {
    if (error.code === "NO_TOKENS" || error.code === "INSUFFICIENT_PERMISSIONS") {
      throw error;
    }
    throw new Error(`Import failed: ${error.message}`);
  }
}

/** Import from multiple OUs at once, each with its own grade and exclusions */
export async function importStudentsMultiOU(
  userId: string,
  schoolId: string,
  entries: Array<{
    orgUnitPath: string;
    gradeLevel?: string;
    excludeEmails?: string[];
  }>,
  domain?: string
): Promise<{
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}> {
  const totals = { imported: 0, updated: 0, skipped: 0, errors: [] as string[] };

  for (const entry of entries) {
    const result = await importStudentsFromDirectory(userId, schoolId, {
      domain,
      orgUnitPath: entry.orgUnitPath,
      gradeLevel: entry.gradeLevel,
      excludeEmails: entry.excludeEmails,
    });
    totals.imported += result.imported;
    totals.updated += result.updated;
    totals.skipped += result.skipped;
    totals.errors.push(...result.errors);
  }

  return totals;
}

/** Import staff/teachers from Google Workspace directory into the users table */
export async function importStaffFromDirectory(
  userId: string,
  schoolId: string,
  options: {
    domain?: string;
    orgUnitPath?: string;
    role?: "teacher" | "school_admin";
    excludeEmails?: string[];
  } = {}
): Promise<{
  imported: number;
  skipped: number;
  errors: string[];
}> {
  const result = { imported: 0, skipped: 0, errors: [] as string[] };

  try {
    let query = "";
    if (options.orgUnitPath) {
      query = `orgUnitPath='${options.orgUnitPath}'`;
    }

    const { users } = await listDomainUsers(userId, options.domain, query);
    const excludeSet = new Set((options.excludeEmails || []).map(e => e.toLowerCase()));
    const activeUsers = users.filter((u) => !u.suspended && !excludeSet.has(u.email.toLowerCase()));
    const role = options.role || "teacher";

    // Get school to validate domain
    const school = await storage.getSchool(schoolId);
    if (!school) throw new Error("School not found");

    for (const user of activeUsers) {
      try {
        const email = user.email.toLowerCase();

        // Validate domain matches school
        const emailDomain = email.split("@")[1];
        if (emailDomain !== school.domain.toLowerCase()) {
          result.skipped++;
          continue;
        }

        const existing = await storage.getUserByEmail(email);
        if (existing) {
          result.skipped++;
          continue;
        }

        await storage.createUser({
          email,
          username: email,
          password: null,
          role,
          schoolId,
          displayName: user.name,
          schoolName: school.name,
        });
        result.imported++;
      } catch (err: any) {
        result.errors.push(`Failed to import ${user.email}: ${err.message}`);
      }
    }

    return result;
  } catch (error: any) {
    if (error.code === "NO_TOKENS" || error.code === "INSUFFICIENT_PERMISSIONS") {
      throw error;
    }
    throw new Error(`Staff import failed: ${error.message}`);
  }
}

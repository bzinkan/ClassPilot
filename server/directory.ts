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

export async function getOrganizationUnits(userId: string): Promise<any[]> {
  try {
    const auth = await getAuthClient(userId);
    const admin = google.admin({ version: "directory_v1", auth });

    const response = await admin.orgunits.list({
      customerId: "my_customer",
      type: "all",
    });

    return response.data.organizationUnits || [];
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

    const activeUsers = users.filter((u) => !u.suspended && !u.isAdmin);

    for (const user of activeUsers) {
      try {
        const existingStudent = await storage.getStudentBySchoolEmail(
          schoolId,
          user.email.toLowerCase()
        );

        if (existingStudent) {
          // Update existing student - also update grade if provided
          const updateData: { studentName: string; gradeLevel?: string } = {
            studentName: user.name,
          };
          if (options.gradeLevel) {
            updateData.gradeLevel = options.gradeLevel;
          }
          await storage.updateStudent(existingStudent.id, updateData);
          result.updated++;
        } else {
          // Create new student with grade level if provided
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

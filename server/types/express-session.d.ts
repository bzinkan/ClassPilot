import "express-session";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    schoolId?: string;
    isSuperAdmin?: boolean;
    impersonatedUserId?: string;
    role?: string;
    impersonating?: boolean;
    originalUserId?: string;
  }
}

export {};

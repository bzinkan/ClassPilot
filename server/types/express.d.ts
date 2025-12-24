import "express-session";
import "express-serve-static-core";
import "http";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    role?: string;
    schoolId?: string;
    isSuperAdmin?: boolean;
    impersonatedUserId?: string;
    impersonating?: boolean;
    originalUserId?: string;
    schoolSessionVersion?: number;
  }
}

declare module "express-serve-static-core" {
  interface Request {
    rawBody?: Buffer;
  }
}

declare module "http" {
  interface IncomingMessage {
    rawBody?: Buffer;
  }
}

export {};

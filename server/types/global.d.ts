import "express-session";

declare module "express-session" {
  interface SessionData {
    userId: string;
    role: string;
    schoolId?: string;
    impersonating?: boolean;
    originalUserId?: string;
  }
}

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

export {};

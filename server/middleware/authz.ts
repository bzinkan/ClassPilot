import type { RequestHandler } from "express";
import type { School } from "@shared/schema";
import type { IStorage } from "../storage";
import { isSchoolEntitled } from "../util/entitlements";

type SessionRole = "teacher" | "school_admin" | "super_admin" | "admin";
const SESSION_COOKIE_NAME = "classpilot_session";

function destroyStaffSession(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], onComplete: () => void) {
  const finalize = () => {
    if (res.headersSent) {
      return;
    }
    res.clearCookie(SESSION_COOKIE_NAME);
    onComplete();
  };
  if (!req.session) {
    finalize();
    return;
  }
  req.session.destroy(() => {
    finalize();
  });
}

function normalizeRole(role?: SessionRole | null): Exclude<SessionRole, "admin"> | undefined {
  if (!role) {
    return undefined;
  }
  if (role === "admin") {
    return "school_admin";
  }
  return role;
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.session?.userId) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized" });
};

export const requireSchoolContext: RequestHandler = (req, res, next) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.session.role === "super_admin") {
    return next();
  }
  if (!req.session?.schoolId) {
    return res.status(400).json({ error: "School context required" });
  }
  res.locals.schoolId = req.session.schoolId;
  return next();
};

export const requireTenantSchool: RequestHandler = (req, res, next) => {
  return requireSchoolContext(req, res, next);
};

export const requireRole = (...roles: Array<Exclude<SessionRole, "admin">>): RequestHandler => {
  const allowed = new Set(roles);
  return (req, res, next) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const normalizedRole = normalizeRole(req.session?.role as SessionRole | undefined);
    if (!normalizedRole || !allowed.has(normalizedRole)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  };
};

export function isSchoolLicenseActive(school?: School | null): boolean {
  return Boolean(
    school
    && school.status !== "suspended"
    && !school.deletedAt
    && isSchoolEntitled(school)
  );
}

export const requireActiveSchool = (
  storage: IStorage,
  opts?: { allowInactive?: boolean }
): RequestHandler => async (req, res, next) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.session.role === "super_admin") {
    return next();
  }

  const schoolId = req.session.schoolId;
  if (!schoolId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const school = await storage.getSchool(schoolId);
  if (!school || school.deletedAt) {
    return destroyStaffSession(req, res, () => {
      res.status(401).json({ error: "Unauthorized" });
    });
  }

  if (
    req.session.schoolSessionVersion !== undefined
    && school.schoolSessionVersion !== undefined
    && req.session.schoolSessionVersion !== school.schoolSessionVersion
  ) {
    return destroyStaffSession(req, res, () => {
      res.status(401).json({ error: "Session invalidated" });
    });
  }

  if (opts?.allowInactive) {
    res.locals.school = school;
    res.locals.schoolActive = isSchoolLicenseActive(school);
    return next();
  }

  res.locals.school = school;

  if (!isSchoolEntitled(school)) {
    return destroyStaffSession(req, res, () => {
      res.status(401).json({ error: "school_not_entitled" });
    });
  }

  return next();
};

export const requireActiveSchoolForDevice = (
  storage: IStorage,
  opts?: { allowInactive?: boolean }
): RequestHandler => async (_req, res, next) => {
  const schoolId = res.locals.schoolId;
  if (!schoolId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const school = await storage.getSchool(schoolId);
  if (!school || school.deletedAt) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (opts?.allowInactive) {
    res.locals.school = school;
    res.locals.schoolActive = isSchoolLicenseActive(school);
    return next();
  }

  res.locals.school = school;

  if (!isSchoolEntitled(school)) {
    return res.status(403).json({ error: "school_not_entitled" });
  }

  return next();
};

export function assertSameSchool(sessionSchoolId?: string | null, resourceSchoolId?: string | null): boolean {
  if (!sessionSchoolId || !resourceSchoolId || sessionSchoolId !== resourceSchoolId) {
    return false;
  }
  return true;
}

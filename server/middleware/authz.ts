import type { RequestHandler } from "express";
import type { School } from "@shared/schema";
import type { IStorage } from "../storage";

type SessionRole = "teacher" | "school_admin" | "super_admin" | "admin";

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
  if (!req.session?.schoolId) {
    return res.status(400).json({ error: "School context required" });
  }
  return next();
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
    && school.isActive === true
    && school.status !== "suspended"
    && school.planStatus !== "canceled"
    && !school.deletedAt
  );
}

export const requireActiveSchool = (
  storage: IStorage,
  opts?: { allowInactive?: boolean }
): RequestHandler => async (req, res, next) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.session.role === "super_admin" || !req.session.schoolId) {
    return next();
  }

  const school = await storage.getSchool(req.session.schoolId);
  if (!school || school.deletedAt) {
    return req.session.destroy(() => {
      res.status(401).json({ error: "Unauthorized" });
    });
  }

  if (
    req.session.schoolSessionVersion !== undefined
    && req.session.schoolSessionVersion !== school.schoolSessionVersion
  ) {
    return req.session.destroy(() => {
      res.status(401).json({ error: "Session invalidated" });
    });
  }

  if (opts?.allowInactive) {
    res.locals.school = school;
    res.locals.schoolActive = isSchoolLicenseActive(school);
    return next();
  }

  if (!isSchoolLicenseActive(school)) {
    return req.session.destroy(() => {
      res.status(402).json({
        error: "School license inactive",
        planStatus: school.planStatus,
        schoolActive: false,
      });
    });
  }

  return next();
};

export function assertSameSchool(sessionSchoolId?: string | null, resourceSchoolId?: string | null): boolean {
  if (!sessionSchoolId || !resourceSchoolId || sessionSchoolId !== resourceSchoolId) {
    return false;
  }
  return true;
}

import type { RequestHandler } from "express";

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

export function assertSameSchool(sessionSchoolId?: string | null, resourceSchoolId?: string | null): boolean {
  if (!sessionSchoolId || !resourceSchoolId || sessionSchoolId !== resourceSchoolId) {
    return false;
  }
  return true;
}

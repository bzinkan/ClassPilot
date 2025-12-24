import type { RequestHandler } from "express";
import { InvalidTokenError, TokenExpiredError, verifyStudentToken } from "../jwt-utils";

function extractBearerToken(rawHeader?: string | string[]): string | null {
  if (!rawHeader) {
    return null;
  }
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const [scheme, token] = header.split(" ");
  if (!scheme || !token) {
    return null;
  }
  if (scheme.toLowerCase() !== "bearer") {
    return null;
  }
  return token.trim() || null;
}

export const requireDeviceAuth: RequestHandler = (req, res, next) => {
  const headerToken = extractBearerToken(req.headers.authorization);
  const bodyToken = typeof req.body?.studentToken === "string" ? req.body.studentToken.trim() : null;
  const token = headerToken ?? bodyToken;

  if (!token) {
    return res.status(401).json({ error: "Device token required" });
  }

  try {
    const payload = verifyStudentToken(token);
    res.locals.schoolId = payload.schoolId;
    res.locals.studentId = payload.studentId;
    res.locals.deviceId = payload.deviceId;
    res.locals.studentEmail = payload.studentEmail;
    res.locals.authType = "device";
    return next();
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      return res.status(401).json({ error: "Student token expired" });
    }
    if (error instanceof InvalidTokenError) {
      return res.status(401).json({ error: "Invalid student token" });
    }
    return res.status(401).json({ error: "Unauthorized" });
  }
};

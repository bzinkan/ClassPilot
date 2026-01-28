import type { Express, Request, RequestHandler } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage as defaultStorage, type IStorage } from "./storage";
import bcrypt from "bcrypt";
import { generateSecurePassword } from "./util/password";
import rateLimit, { type Options } from "express-rate-limit";
import { z } from "zod";
import {
  insertDeviceSchema,
  insertStudentSchema,
  insertHeartbeatSchema,
  heartbeatRequestSchema, // 🆕 Includes allOpenTabs (in-memory only)
  insertEventSchema,
  insertRosterSchema,
  insertSettingsSchema,
  settings as settingsTable,
  insertFlightPathSchema,
  insertBlockListSchema,
  insertStudentGroupSchema,
  insertDashboardTabSchema,
  insertGroupSchema,
  insertSessionSchema,
  loginSchema,
  createTeacherSchema,
  adminResetPasswordSchema,
  createSchoolRequestSchema, // Validation schema for creating schools
  normalizeEmail, // Email normalization helper
  trialRequests, // Trial request submissions
  insertTrialRequestSchema, // Validation schema for trial requests
  type StudentStatus,
  type SignalMessage,
  type InsertRoster,
  type InsertSchool,
  type InsertStudent,
  type InsertDevice,
  type School,
} from "@shared/schema";
import { groupSessionsByDevice, formatDuration, isTrackingAllowedNow, isSchoolTrackingAllowed } from "@shared/utils";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { createStudentToken, verifyStudentToken, TokenExpiredError, InvalidTokenError } from "./jwt-utils";
import { syncCourses, syncRoster } from "./classroom";
import { getBaseUrl } from "./config/baseUrl";
import { publishWS, subscribeWS, isRedisEnabled, setScreenshot, getScreenshot, setFlightPathStatus, getFlightPathStatus, setDeviceLastSeen, getDeviceLastSeen, type WsRedisTarget, type ScreenshotData, type FlightPathStatus } from "./ws-redis";
import {
  authenticateWsClient,
  broadcastToStudentsLocal,
  broadcastToTeachersLocal,
  closeSocketsForSchool,
  registerWsClient,
  removeWsClient,
  sendToDeviceLocal,
  sendToRoleLocal,
} from "./ws-broadcast";
import type { WSClient } from "./ws-broadcast";
import {
  assertSameSchool,
  isSchoolLicenseActive,
  requireActiveSchool,
  requireActiveSchoolForDevice,
  requireAuth,
  requireRole,
  requireSchoolContext,
} from "./middleware/authz";
import { requireDeviceAuth } from "./middleware/requireDeviceAuth";
import { deviceRateLimit } from "./middleware/deviceRateLimit";
import { parseCsv, stringifyCsv } from "./util/csv";
import { assertEmailMatchesDomain, EmailDomainError } from "./util/emailDomain";
import { assertTierAtLeast, PLAN_STATUS_VALUES, PLAN_TIER_ORDER } from "./util/entitlements";
import { logAudit, logAuditFromRequest, AuditAction } from "./audit";
import { sendTrialRequestNotification } from "./util/email";
import { createCheckoutSession, createCustomInvoice, handleWebhookEvent, constructWebhookEvent, stripe as stripeClient } from "./stripe";

// Helper function to normalize and validate grade levels
function normalizeGradeLevel(grade: string | null | undefined): string | null {
  if (!grade) return null;

  const trimmed = grade.trim();
  if (!trimmed) return null;

  // Security: Limit grade level length to prevent DoS
  if (trimmed.length > 50) {
    throw new Error("Grade level too long (max 50 characters)");
  }

  // Remove common ordinal suffixes (case-insensitive)
  // Matches: 1st, 2nd, 3rd, 4th, 5th, etc. and returns just the number
  const normalized = trimmed.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');

  // Also handle special cases like "Kindergarten" → "K"
  if (/^kindergarten$/i.test(normalized)) {
    return 'K';
  }

  // Validate against acceptable grade levels
  const validGrades = ['PK', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
  if (!validGrades.includes(normalized.toUpperCase())) {
    // Allow the value but log a warning
    console.warn(`[grade-level] Non-standard grade level: ${normalized}`);
  }

  return normalized;
}

// Dev-only sanity check to verify tenant scoping in settings routes.
function logSettingsSchoolId(schoolId: string) {
  if (process.env.NODE_ENV !== "production") {
    console.info(`[settings] Handling /api/settings for schoolId=${schoolId}`);
  }
}

const resetUserPasswordSchema = z.object({
  password: z.string().min(12, "Password must be at least 12 characters"),
});

const accountPasswordSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  newPassword: z.string().min(10, "Password must be at least 10 characters"),
});

const adminUserCreateSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: z.enum(["teacher", "school_admin"]),
  name: z.string().min(1, "Name is required").optional(),
  password: z.string().nullable().optional(),
});

const adminUserUpdateSchema = z.object({
  role: z.enum(["teacher", "school_admin"]).optional(),
  name: z.string().min(1, "Name is required").optional(),
});

// Helper function to extract domain from email and lookup school
async function getSchoolFromEmail(
  storage: IStorage,
  email: string
): Promise<{ schoolId: string; schoolName: string } | null> {
  // Extract domain from email (part after @)
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    console.error('[getSchoolFromEmail] Invalid email supplied');
    return null;
  }
  
  const domain = normalizedEmail.split('@')[1];
  if (!domain) {
    console.error('[getSchoolFromEmail] No domain found in email');
    return null;
  }
  
  // Look up school by domain
  const school = await storage.getSchoolByDomain(domain);
  if (!school) {
    console.warn('[getSchoolFromEmail] No school found for provided domain');
    return null;
  }
  
  return {
    schoolId: school.id,
    schoolName: school.name,
  };
}

type LicenseLimitError = Error & { code: "LICENSE_LIMIT_REACHED"; maxLicenses: number; currentCount: number };

function isLicenseLimitError(error: unknown): error is LicenseLimitError {
  return error instanceof Error && (error as LicenseLimitError).code === "LICENSE_LIMIT_REACHED";
}

function buildLicenseLimitResponse(error: LicenseLimitError) {
  return {
    code: "LICENSE_LIMIT_REACHED",
    error: `Student limit reached for this school (${error.maxLicenses}).`,
    maxLicenses: error.maxLicenses,
    currentCount: error.currentCount,
  };
}

async function countSchoolAdmins(storage: IStorage, schoolId: string): Promise<number> {
  const users = await storage.getUsersBySchool(schoolId);
  return users.filter((user) => user.role === "school_admin").length;
}

// SESSION-BASED: Helper to ensure student-device association exists
// INDUSTRY STANDARD: Device identity (primary) → Email (student identity) → Sessions (active tracking)
// Used by both heartbeat endpoint and WebSocket auth handler
async function ensureStudentDeviceAssociation(
  storage: IStorage,
  deviceId: string,
  studentEmail: string,
  schoolId: string
): Promise<any> {
  // Normalize email for consistent lookups
  const normalizedEmail = normalizeEmail(studentEmail);

  // DEVICE-FIRST: Look up student by email (email = student identity, device = stable ID)
  let student = await storage.getStudentBySchoolEmail(schoolId, normalizedEmail);

  if (student) {
    // Update student's current deviceId if changed (tracks most recent device)
    if (student.deviceId !== deviceId) {
      await storage.updateStudent(student.id, { deviceId });
    }

    // Track historical student-device relationship
    await storage.upsertStudentDevice(student.id, deviceId);

    // Start or update session (automatically handles device switches and evictions)
    await storage.startStudentSession(student.id, deviceId);

    return student;
  }

  // Student not found - auto-provision placeholder record
  const newStudent = await storage.createStudent({
    deviceId,
    studentName: normalizedEmail.split('@')[0], // Use email prefix as placeholder
    studentEmail: normalizedEmail,
    gradeLevel: null,
    schoolId,
    studentStatus: 'active',
  });

  // Track historical student-device relationship
  await storage.upsertStudentDevice(newStudent.id, deviceId);

  // Start session for new student
  await storage.startStudentSession(newStudent.id, deviceId);

  return newStudent;
}

// Rate limiters
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiter for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 login attempts per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many login attempts. Please try again later.",
  skipSuccessfulRequests: true, // Only count failed attempts
});

// Per-device heartbeat rate limiter (critical for production)
const heartbeatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 120, // 120 requests per minute per device (~2/sec)
  keyGenerator: (req) => {
    const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
    if (deviceId) {
      return `heartbeat:${deviceId}`;
    }
    // Fallback to a constant key when no deviceId - all non-device requests share same bucket
    return "heartbeat:no-device";
  },
  validate: false,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  handler: (req, res, _next, options) => {
    res.status(options.statusCode).json({
      error: "Too many heartbeat requests",
      retryAfterMs: req.rateLimit?.resetTime
        ? Math.max(0, req.rateLimit.resetTime.getTime() - Date.now())
        : undefined,
    });
  },
});

const HEARTBEAT_MIN_PERSIST_SECONDS = (() => {
  const rawValue = process.env.HEARTBEAT_MIN_PERSIST_SECONDS;
  const parsed = rawValue ? Number.parseInt(rawValue, 10) : 15;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 15;
  }
  return parsed;
})();

const HEARTBEAT_PERSIST_MIN_MS = HEARTBEAT_MIN_PERSIST_SECONDS * 1000;
const heartbeatLastPersistedAt = new Map<string, number>();
const heartbeatLastAcceptedAt = new Map<string, number>();
const heartbeatLastFullPayloadAt = new Map<string, number>();
const DEVICE_HEARTBEAT_MIN_INTERVAL_MS = 8_000;
const HEARTBEAT_FULL_PAYLOAD_MIN_MS = 30_000;

// Screenshot thumbnail storage
// Uses Redis when available (multi-instance), falls back to in-memory (single-instance)
// Key: deviceId, Value: { screenshot, timestamp, and tab metadata from when screenshot was taken }
const SCREENSHOT_TTL_MS = 60_000; // 60 seconds TTL
const SCREENSHOT_MAX_SIZE_BYTES = 200_000; // ~200KB max per screenshot
// In-memory fallback for single-instance mode (when Redis is not available)
const deviceScreenshotsLocal = new Map<string, ScreenshotData>();

// Cleanup expired screenshots periodically (only needed for in-memory storage)
setInterval(() => {
  const now = Date.now();
  deviceScreenshotsLocal.forEach((data, deviceId) => {
    if (now - data.timestamp > SCREENSHOT_TTL_MS) {
      deviceScreenshotsLocal.delete(deviceId);
    }
  });
}, 30_000); // Run cleanup every 30 seconds

const HEARTBEAT_QUEUE_MAX = 500;
const heartbeatPersistQueue: Array<() => Promise<void>> = [];
let heartbeatQueueActive = false;

async function processHeartbeatQueue() {
  if (heartbeatQueueActive) {
    return;
  }
  heartbeatQueueActive = true;
  while (heartbeatPersistQueue.length > 0) {
    const task = heartbeatPersistQueue.shift();
    if (!task) {
      continue;
    }
    try {
      await task();
    } catch (error) {
      console.error("[heartbeat] Persist error:", error);
    }
  }
  heartbeatQueueActive = false;
}

function enqueueHeartbeatPersist(task: () => Promise<void>): boolean {
  if (heartbeatPersistQueue.length >= HEARTBEAT_QUEUE_MAX) {
    console.warn("[heartbeat] Persist queue full; dropping heartbeat.");
    return false;
  }
  heartbeatPersistQueue.push(task);
  void processHeartbeatQueue();
  return true;
}

let publishWsMessage: ((target: WsRedisTarget, message: unknown) => void) | null = null;

function broadcastToTeachers(schoolId: string, message: any) {
  broadcastToTeachersLocal(schoolId, message);
  publishWsMessage?.({ kind: "staff", schoolId }, message);
}

function broadcastToStudents(
  schoolId: string,
  message: any,
  filterFn?: (client: WSClient) => boolean,
  targetDeviceIds?: string[]
): number {
  const sentCount = broadcastToStudentsLocal(schoolId, message, filterFn, targetDeviceIds);
  if (!filterFn) {
    publishWsMessage?.({ kind: "students", schoolId, targetDeviceIds }, message);
  }
  return sentCount;
}

function sendToDevice(schoolId: string, deviceId: string, message: any) {
  sendToDeviceLocal(schoolId, deviceId, message);
  publishWsMessage?.({ kind: "device", schoolId, deviceId }, message);
}

function sendToRole(
  schoolId: string,
  role: "teacher" | "school_admin" | "super_admin" | "student",
  message: any
) {
  sendToRoleLocal(schoolId, role, message);
  publishWsMessage?.({ kind: "role", schoolId, role }, message);
}

function isFullHeartbeatPayload(req: Request): boolean {
  const headerValue = req.headers["x-heartbeat-full"];
  const normalizedHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (normalizedHeader && ["1", "true", "yes"].includes(normalizedHeader.toLowerCase())) {
    return true;
  }

  const body = req.body as Record<string, unknown> | undefined;
  if (!body) {
    return false;
  }

  const flag = body.fullPayload === true || body.fullHeartbeat === true;
  const hasAllOpenTabs = Array.isArray(body.allOpenTabs) && body.allOpenTabs.length > 0;
  const hasTabs = Array.isArray(body.tabs) && body.tabs.length > 0;
  const hasUrls = Array.isArray(body.urls) && body.urls.length > 0;

  return Boolean(flag || hasAllOpenTabs || hasTabs || hasUrls);
}

function stripHeavyHeartbeatFields(body: Record<string, unknown> | undefined) {
  if (!body) {
    return {};
  }
  const sanitized = { ...body };
  delete sanitized.allOpenTabs;
  delete sanitized.tabs;
  delete sanitized.urls;
  delete sanitized.openTabs;
  return sanitized;
}

let activeStorage: IStorage = defaultStorage;

const requireTeacherRole = requireRole("teacher", "school_admin", "super_admin");
const requireAdminRole = requireRole("school_admin", "super_admin");
const requireSchoolAdminRole = requireRole("school_admin", "super_admin");
const requireSuperAdminRole = requireRole("super_admin");

// IP allowlist middleware (only enforced in production)
async function checkIPAllowlist(req: any, res: any, next: any) {
  // Skip IP check in development
  if (process.env.NODE_ENV !== 'production') {
    return next();
  }

  try {
    const schoolId = res.locals.schoolId ?? req.session?.schoolId;
    if (!schoolId) {
      return next();
    }

    const settings = await activeStorage.getSettingsBySchoolId(schoolId);
    
    // If no allowlist configured, allow all IPs
    if (!settings || !settings.ipAllowlist || settings.ipAllowlist.length === 0) {
      return next();
    }

    // Get client IP - use socket address directly (don't trust proxy headers for security)
    // In production deployments behind a trusted proxy, configure Express's "trust proxy" setting
    // and use req.ip instead. For now, we use direct socket address for security.
    let clientIP = req.connection?.remoteAddress || 
                   req.socket?.remoteAddress ||
                   '';

    // Normalize IPv6-mapped IPv4 addresses (::ffff:192.168.1.1 -> 192.168.1.1)
    if (clientIP.startsWith('::ffff:')) {
      clientIP = clientIP.substring(7);
    }

    // Check if IP is in allowlist (exact match only - CIDR support would require ipaddr.js)
    const isAllowed = settings.ipAllowlist.some(allowedIP => {
      // Normalize allowed IP as well
      let normalizedAllowedIP = allowedIP;
      if (normalizedAllowedIP.startsWith('::ffff:')) {
        normalizedAllowedIP = normalizedAllowedIP.substring(7);
      }
      
      // Exact match only for security
      return clientIP === normalizedAllowedIP;
    });

    if (isAllowed) {
      next();
    } else {
      console.warn(`Blocked request from unauthorized IP: ${clientIP}`);
      res.status(403).json({ error: "Access denied: IP not in allowlist" });
    }
  } catch (error) {
    console.error("IP allowlist check error:", error);
    // On error, allow the request to proceed (fail open)
    next();
  }
}

export async function registerRoutes(
  app: Express,
  options: {
    storage?: IStorage;
    sessionMiddleware: RequestHandler;
    enableBackgroundJobs?: boolean;
  }
): Promise<Server> {
  const storage = options.storage ?? defaultStorage;
  activeStorage = storage;
  publishWsMessage = null;
  const enableBackgroundJobs = options.enableBackgroundJobs !== false;
  const httpServer = createServer(app);
  const requireActiveSchoolMiddleware = requireActiveSchool(storage);
  const requireActiveSchoolDeviceMiddleware = requireActiveSchoolForDevice(storage);

  // WebSocket server with noServer mode for manual upgrade handling
  const wss = new WebSocketServer({ noServer: true });

  const deliverRedisMessage = (target: WsRedisTarget, message: unknown) => {
    const msgType = (message as { type?: string })?.type ?? 'unknown';
    switch (target.kind) {
      case "staff":
        broadcastToTeachersLocal(target.schoolId, message);
        break;
      case "students":
        broadcastToStudentsLocal(target.schoolId, message, undefined, target.targetDeviceIds);
        break;
      case "device":
        console.log(`[Redis] Delivering ${msgType} to device ${target.deviceId}`);
        sendToDeviceLocal(target.schoolId, target.deviceId, message);
        break;
      case "role":
        sendToRoleLocal(target.schoolId, target.role, message);
        break;
    }
  };

  publishWsMessage = (target, message) => {
    void publishWS(target, message);
  };
  void subscribeWS(deliverRedisMessage);

  // SECURITY: Handle WebSocket upgrade with session validation
  httpServer.on('upgrade', (request, socket, head) => {
    const rawUrl = request.url ?? "/";
    let pathname = rawUrl;
    try {
      pathname = new URL(rawUrl, "http://localhost").pathname;
    } catch (error) {
      console.warn("[WebSocket] Failed to parse upgrade URL:", error);
    }

    // SECURITY: Only handle WebSocket upgrades for /ws path
    if (pathname !== "/ws" && pathname !== "/ws/") {
      console.warn("[WebSocket] Rejected upgrade attempt for invalid path:", pathname);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // Parse session from cookies (for staff authentication)
    // Note: For students (no session), this still allows connection but sessionUserId will be null
    options.sessionMiddleware(request as any, {} as any, (err: any) => {
      if (err) {
        console.error('[WebSocket] Session middleware error:', err);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
        return;
      }

      // Session is now available in request.session (if present)
      // Students won't have sessions, which is expected
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });
  });

  // WebSocket ping/pong keepalive to prevent ALB idle timeout (60s default)
  const WS_PING_INTERVAL_MS = 30000; // 30 seconds
  const WS_PONG_TIMEOUT_MS = 10000;  // 10 seconds to respond
  const clientPingTimers = new Map<WebSocket, NodeJS.Timeout>();
  const clientPongPending = new Map<WebSocket, boolean>();

  function startPingInterval(ws: WebSocket) {
    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(timer);
        clientPingTimers.delete(ws);
        return;
      }

      // Check if previous pong was received
      if (clientPongPending.get(ws)) {
        console.log('[WebSocket] Client failed to respond to ping, closing connection');
        ws.terminate();
        return;
      }

      // Send ping and mark pong as pending
      clientPongPending.set(ws, true);
      ws.ping();
    }, WS_PING_INTERVAL_MS);

    clientPingTimers.set(ws, timer);
  }

  function stopPingInterval(ws: WebSocket) {
    const timer = clientPingTimers.get(ws);
    if (timer) {
      clearInterval(timer);
      clientPingTimers.delete(ws);
    }
    clientPongPending.delete(ws);
  }

  wss.on('connection', (ws, req: any) => {
    const client = registerWsClient(ws);

    // SECURITY: Extract session info if available (staff have sessions, students don't)
    const sessionUserId = req.session?.userId || null;
    const sessionRole = req.session?.role || null;

    console.log('WebSocket client connected', {
      hasSession: !!sessionUserId,
      sessionRole: sessionRole || 'none'
    });

    // Start ping/pong keepalive
    startPingInterval(ws);

    // Handle pong responses
    ws.on('pong', () => {
      clientPongPending.set(ws, false);
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Log all non-auth messages for debugging WebRTC signaling
        if (message.type !== 'auth' && message.type !== 'heartbeat') {
          console.log(`[WebSocket] Message received: ${message.type} from ${client.role || 'unauthenticated'} (authenticated: ${client.authenticated})`);
        }

        // Handle authentication
        if (message.type === 'auth') {
          if (message.role === 'teacher' || message.role === 'school_admin' || message.role === 'super_admin') {
            // SECURITY FIX: Verify userId matches session instead of trusting client
            // Staff must be logged in via HTTP session before connecting WebSocket
            if (!sessionUserId) {
              console.warn('[WebSocket] Staff auth attempt without valid session');
              ws.send(JSON.stringify({ type: 'auth-error', message: 'Session required. Please log in.' }));
              ws.close();
              return;
            }
            
            // SECURITY: Reject if client-provided userId doesn't match session
            const claimedUserId = message.userId;
            if (claimedUserId !== sessionUserId) {
              console.error('[WebSocket] SECURITY: userId mismatch!', {
                claimed: claimedUserId,
                session: sessionUserId
              });
              ws.send(JSON.stringify({ type: 'auth-error', message: 'Authentication failed' }));
              ws.close();
              return;
            }
            
            try {
              // Fetch user from database to get current role
              const user = await storage.getUser(sessionUserId);
              if (!user) {
                ws.send(JSON.stringify({ type: 'auth-error', message: 'User not found' }));
                ws.close();
                return;
              }
              const sessionSchoolId = req.session?.schoolId;
              if (!sessionSchoolId) {
                ws.send(JSON.stringify({ type: 'auth-error', message: 'School context required' }));
                ws.close();
                return;
              }
              if (user.schoolId && !assertSameSchool(sessionSchoolId, user.schoolId)) {
                ws.send(JSON.stringify({ type: 'auth-error', message: 'Authentication failed' }));
                ws.close();
                return;
              }
              const school = await storage.getSchool(sessionSchoolId);
              if (!school || !isSchoolLicenseActive(school)) {
                ws.send(JSON.stringify({ type: 'auth-error', message: 'School inactive' }));
                ws.close();
                return;
              }
              
              // Verify user is a staff member (not a student role)
              if (!['teacher', 'school_admin', 'super_admin'].includes(user.role)) {
                ws.send(JSON.stringify({ type: 'auth-error', message: 'Invalid role' }));
                ws.close();
                return;
              }
              
              // Authenticate with ACTUAL role from database (not from client OR session)
              authenticateWsClient(ws, {
                role: user.role as 'teacher' | 'school_admin' | 'super_admin',
                userId: user.id,
                schoolId: sessionSchoolId,
              });
              console.log(`[WebSocket] Staff authenticated: ${user.role} (userId: ${client.userId})`);
              ws.send(JSON.stringify({ type: 'auth-success', role: user.role }));
            } catch (error) {
              console.error('[WebSocket] Auth error:', error);
              ws.send(JSON.stringify({ type: 'auth-error', message: 'Authentication failed' }));
              ws.close();
              return;
            }
          } else if (message.role === 'student' && message.deviceId) {
            let schoolId: string | undefined;
            let studentEmail: string | undefined;
            let deviceId = message.deviceId as string;

            if (message.studentToken) {
              try {
                const payload = verifyStudentToken(message.studentToken);
                schoolId = payload.schoolId;
                studentEmail = payload.studentEmail ?? undefined;
                deviceId = payload.deviceId;
              } catch (error) {
                if (error instanceof TokenExpiredError) {
                  ws.send(JSON.stringify({ type: 'auth-error', message: 'Token expired, please re-register' }));
                  ws.close();
                  return;
                }
                ws.send(JSON.stringify({ type: 'auth-error', message: 'Invalid token' }));
                ws.close();
                return;
              }
            } else if (message.studentEmail) {
              const email = message.studentEmail;
              if (email) {
                studentEmail = email;
                const schoolInfo = await getSchoolFromEmail(storage, email);
                schoolId = schoolInfo?.schoolId;
              }
            }

            if (!schoolId) {
              ws.send(JSON.stringify({ type: 'auth-error', message: 'School context required' }));
              ws.close();
              return;
            }

            const school = await storage.getSchool(schoolId);
            if (!school || !isSchoolLicenseActive(school)) {
              ws.send(JSON.stringify({ type: 'auth-error', message: 'School inactive' }));
              ws.close();
              return;
            }

            authenticateWsClient(ws, {
              role: 'student',
              deviceId,
              schoolId,
            });
            
            // EMAIL-FIRST AUTO-PROVISIONING: If auth has email+schoolId, ensure student exists
            if (studentEmail && schoolId) {
              try {
                await ensureStudentDeviceAssociation(storage, deviceId, studentEmail, schoolId);
              } catch (error) {
                console.error('[WebSocket] Email-first provisioning error:', error);
                // Continue with auth even if provisioning fails
              }
            }
            
            // Get school settings and send maxTabsPerStudent to extension
            try {
              const settings = await storage.ensureSettingsForSchool(schoolId);
              // Always send maxTabsPerStudent (including null for unlimited)
              // Parse the value if it exists, otherwise use null
              let maxTabs: number | null = null;
              if (settings?.maxTabsPerStudent !== null && settings?.maxTabsPerStudent !== undefined) {
                const parsed = parseInt(settings.maxTabsPerStudent, 10);
                // Only use parsed value if it's a valid positive integer
                // Treat 0, negative, or invalid as unlimited (null)
                maxTabs = (!isNaN(parsed) && parsed > 0) ? parsed : null;
              }
              
              // Get global blocked domains (school-wide blacklist)
              const globalBlockedDomains = settings?.blockedDomains || [];

              ws.send(JSON.stringify({
                type: 'auth-success',
                role: 'student',
                settings: {
                  maxTabsPerStudent: maxTabs,
                  globalBlockedDomains: globalBlockedDomains
                }
              }));
            } catch (error) {
              console.error('Error fetching settings for student auth:', error);
              // Even on error, send null to indicate no limit and empty blacklist
              ws.send(JSON.stringify({
                type: 'auth-success',
                role: 'student',
                settings: {
                  maxTabsPerStudent: null,
                  globalBlockedDomains: []
                }
              }));
            }
          }
        }

        // Handle WebRTC signaling messages
        if (!client.authenticated) return;

        // Route WebRTC signaling messages between teacher and students
        if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice') {
          const targetDeviceId = message.to;
          if (!targetDeviceId) {
            console.log(`[WebSocket] Dropping ${message.type} - missing 'to' field`);
            return;
          }

          console.log(`[WebSocket] Routing ${message.type} between clients`);

          if (targetDeviceId === 'teacher') {
            const payload = {
              type: message.type,
              from: client.deviceId,
              ...message
            };
            if (client.schoolId) {
              sendToRole(client.schoolId, 'teacher', payload);
            }
            console.log(`[WebSocket] Sent ${message.type} to teacher`);
          } else {
            const payload = {
              type: message.type,
              from: client.role === 'teacher' ? 'teacher' : client.deviceId,
              ...message
            };
            if (client.schoolId) {
              sendToDevice(client.schoolId, targetDeviceId, payload);
            }
            console.log(`[WebSocket] Sent ${message.type} to student ${targetDeviceId}`);
          }
        }

        // Handle request to start screen sharing from teacher to student
        if (message.type === 'request-stream' && client.role === 'teacher') {
          const targetDeviceId = message.deviceId;
          console.log(`[WebSocket] Received request-stream for device: ${targetDeviceId}`);
          if (!targetDeviceId) return;

          // No additional permission check needed here
          // Dashboard visibility already controls which students teachers can see
          // If a teacher can see a student tile, they can use Live View

          // Forward the request to the student device
          if (client.schoolId) {
            console.log(`[WebSocket] Forwarding request-stream to ${targetDeviceId} (schoolId: ${client.schoolId})`);
            sendToDevice(client.schoolId, targetDeviceId, {
              type: 'request-stream',
              from: 'teacher'
            });
          }
        }

        // Handle request to stop screen sharing from teacher to student
        if (message.type === 'stop-share' && client.role === 'teacher') {
          const targetDeviceId = message.deviceId;
          if (!targetDeviceId) return;

          console.log(`[WebSocket] Sending stop-share to ${targetDeviceId}`);
          if (client.schoolId) {
            sendToDevice(client.schoolId, targetDeviceId, {
              type: 'stop-share',
              from: 'teacher'
            });
          }
          console.log(`[WebSocket] Sent stop-share to ${targetDeviceId}`);
        }

        } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    ws.on('close', () => {
      stopPingInterval(ws);
      removeWsClient(ws);
      console.log('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      stopPingInterval(ws);
      removeWsClient(ws);
    });
  });

  // Authentication endpoints
  app.post("/api/login", authLimiter, async (req, res) => {
    try {
      const { email, username, password } = loginSchema.parse(req.body);
      
      // Try to find user by email (preferred) or username (legacy)
      let user;
      if (email) {
        user = await storage.getUserByEmail(email);
      } else if (username) {
        user = await storage.getUserByUsername(username);
      }

      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      if (!user.password) {
        return res.status(401).json({ error: "This account uses Google OAuth. Please sign in with Google." });
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        const initialPassword = process.env.NODE_ENV === "test"
          ? (user as { initialPassword?: string | null }).initialPassword
          : null;
        if (!initialPassword || !(await bcrypt.compare(password, initialPassword))) {
          return res.status(401).json({ error: "Invalid credentials" });
        }
      }

      let schoolSessionVersion: number | undefined;
      if (user.schoolId) {
        const school = await storage.getSchool(user.schoolId);
        if (!school || school.deletedAt) {
          return res.status(401).json({ error: "School not found" });
        }
        if (!isSchoolLicenseActive(school)) {
          return res.status(402).json({
            error: "School license inactive",
            planStatus: school.planStatus,
            schoolActive: false,
          });
        }
        schoolSessionVersion = school.schoolSessionVersion;
      }

      // Set session data with role and schoolId
      req.session.userId = user.id;
      req.session.role = user.role;
      req.session.schoolId = user.schoolId ?? undefined;
      req.session.schoolSessionVersion = schoolSessionVersion;

      // Log successful login (non-blocking)
      if (user.schoolId) {
        logAudit({
          userId: user.id,
          userEmail: user.email,
          userRole: user.role,
          schoolId: user.schoolId,
          ipAddress: req.ip || req.connection?.remoteAddress,
          userAgent: req.get('user-agent'),
        }, AuditAction.LOGIN, {
          metadata: { method: 'password' },
        }).catch(() => {}); // Ignore errors
      }

      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
          schoolId: user.schoolId,
          displayName: user.displayName
        }
      });
    } catch (error) {
      console.error("Login error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.post("/api/logout", (req, res) => {
    const userId = req.session?.userId;
    const userRole = req.session?.role;
    const schoolId = req.session?.schoolId;

    // Log logout (non-blocking)
    if (userId && schoolId) {
      logAudit({
        userId,
        userRole,
        schoolId,
        ipAddress: req.ip || req.connection?.remoteAddress,
        userAgent: req.get('user-agent'),
      }, AuditAction.LOGOUT).catch(() => {}); // Ignore errors
    }

    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  // Version endpoint for deployment verification
  app.get("/api/version", async (req, res) => {
    try {
      const version = {
        commit: 'v2.0.0-session-fix',
        timestamp: new Date().toISOString(),
        features: [
          'deviceId→studentId mapping',
          'rate-limit-1000/min',
          'session-based-roster-visibility',
          'ensureStudentDeviceAssociation',
          'aggressive-session-logging'
        ]
      };
      res.json(version);
    } catch (error) {
      res.status(500).json({ error: 'Failed to get version' });
    }
  });

  app.post("/api/school/status", async (req, res) => {
    try {
      const { studentToken, studentEmail } = req.body ?? {};
      let schoolId: string | undefined;

      if (req.session?.schoolId) {
        schoolId = req.session.schoolId;
      } else if (studentToken) {
        try {
          const payload = verifyStudentToken(studentToken);
          schoolId = payload.schoolId;
        } catch (error) {
          return res.status(401).json({ error: "Invalid token" });
        }
      } else if (studentEmail) {
        const schoolInfo = await getSchoolFromEmail(storage, studentEmail);
        schoolId = schoolInfo?.schoolId;
      }

      if (!schoolId) {
        return res.status(400).json({ error: "School context required" });
      }

      const school = await storage.getSchool(schoolId);
      if (!school) {
        return res.status(404).json({ schoolActive: false });
      }

      const schoolActive = isSchoolLicenseActive(school);

      return res.json({
        schoolId,
        schoolActive,
        planStatus: school.planStatus,
        status: school.status,
        schoolSessionVersion: school.schoolSessionVersion,
      });
    } catch (error) {
      console.error("School status error:", error);
      return res.status(500).json({ error: "Failed to load school status" });
    }
  });

  // Public endpoint: Submit a trial request (no auth required)
  app.post("/api/trial-requests", apiLimiter, async (req, res) => {
    try {
      const validationResult = insertTrialRequestSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          error: "Invalid request data",
          details: validationResult.error.errors
        });
      }

      const data = validationResult.data;

      // Check if a request with this email already exists (prevent spam)
      const existingRequest = await db.select()
        .from(trialRequests)
        .where(sql`LOWER(${trialRequests.adminEmail}) = LOWER(${data.adminEmail})`)
        .limit(1);

      if (existingRequest.length > 0) {
        // Return success anyway to prevent email enumeration
        console.log(`[Trial Request] Duplicate request from ${data.adminEmail}`);
        return res.json({ success: true, message: "Trial request submitted successfully" });
      }

      // Insert the trial request
      const [newRequest] = await db.insert(trialRequests).values({
        schoolName: data.schoolName,
        schoolDomain: data.schoolDomain.toLowerCase(),
        adminFirstName: data.adminFirstName,
        adminLastName: data.adminLastName,
        adminEmail: data.adminEmail.toLowerCase(),
        adminPhone: data.adminPhone || null,
        estimatedStudents: data.estimatedStudents || null,
        estimatedTeachers: data.estimatedTeachers || null,
        message: data.message || null,
      }).returning();

      console.log(`[Trial Request] New request from ${data.schoolName} (${data.adminEmail})`);

      // Send email notification to admin (non-blocking)
      sendTrialRequestNotification({
        schoolName: data.schoolName,
        schoolDomain: data.schoolDomain,
        adminFirstName: data.adminFirstName,
        adminLastName: data.adminLastName,
        adminEmail: data.adminEmail,
        adminPhone: data.adminPhone,
        estimatedStudents: data.estimatedStudents,
        estimatedTeachers: data.estimatedTeachers,
        message: data.message,
      }).catch((err) => {
        console.error("[Trial Request] Failed to send email notification:", err);
      });

      res.json({ success: true, message: "Trial request submitted successfully" });
    } catch (error) {
      console.error("Trial request error:", error);
      res.status(500).json({ error: "Failed to submit trial request" });
    }
  });

  // Debug endpoint for production troubleshooting (admin only)
  app.get("/api/debug/student-status", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const { email } = req.query;
      
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Email query parameter required' });
      }
      
      const normalizedEmail = normalizeEmail(email);
      const schoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      // Get student by email
      const student = await storage.getStudentBySchoolEmail(schoolId, normalizedEmail);
      
      if (!student) {
        return res.json({ 
          found: false, 
          email: normalizedEmail,
          schoolId,
          message: 'No student found with this email' 
        });
      }
      
      // Get active session
      const activeSession = await storage.findActiveStudentSession(student.id);
      
      // Get recent heartbeats
      const allHeartbeats = await storage.getHeartbeatsBySchool(schoolId);
      const recentHeartbeats = allHeartbeats
        .filter(hb => hb.studentEmail === normalizedEmail)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 5);
      
      res.json({
        found: true,
        student: {
          id: student.id,
          studentEmail: student.studentEmail,
          studentName: student.studentName,
          deviceId: student.deviceId,
          gradeLevel: student.gradeLevel,
        },
        activeSession: activeSession ? {
          id: activeSession.id,
          deviceId: activeSession.deviceId,
          isActive: activeSession.isActive,
          lastSeenAt: activeSession.lastSeenAt,
          startedAt: activeSession.startedAt,
        } : null,
        recentHeartbeats: recentHeartbeats.map(hb => ({
          deviceId: hb.deviceId,
          timestamp: hb.timestamp,
          activeTabUrl: hb.activeTabUrl?.substring(0, 50),
        })),
        debug: {
          lookupEmail: normalizedEmail,
          schoolId,
          timestamp: new Date().toISOString(),
        }
      });
    } catch (error) {
      console.error('Debug endpoint error:', error);
      res.status(500).json({ error: 'Internal server error', details: String(error) });
    }
  });

  app.get("/api/me", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get school name from schools table (user.schoolName is deprecated)
      let schoolName = user.schoolName; // fallback to deprecated field
      if (user.schoolId) {
        const school = await storage.getSchool(user.schoolId);
        if (school) {
          schoolName = school.name;
        }
      }

      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          schoolName: schoolName,
          impersonating: req.session.impersonating || false,
        },
      });
    } catch (error) {
      console.error("Get user error:", error);
      res.status(500).json({ error: "Failed to fetch user" });
    }
  });

  app.get("/api/account/security", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ hasPassword: Boolean(user.password) });
    } catch (error) {
      console.error("Account security error:", error);
      res.status(500).json({ error: "Failed to fetch account security" });
    }
  });

  app.post("/api/account/password", requireAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword } = accountPasswordSchema.parse(req.body);
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (user.password) {
        if (!currentPassword) {
          return res.status(400).json({ error: "Current password is required." });
        }
        const matches = await bcrypt.compare(currentPassword, user.password);
        if (!matches) {
          return res.status(400).json({ error: "Current password is incorrect." });
        }
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await storage.updateUser(user.id, { password: hashedPassword });

      res.json({ ok: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors[0]?.message ?? "Invalid request" });
      }
      console.error("Account password error:", error);
      res.status(500).json({ error: "Failed to update password" });
    }
  });

  // Admin routes for managing staff
  app.get("/api/admin/users", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireSchoolAdminRole, async (req, res) => {
    try {
      const admin = await storage.getUser(req.session.userId!);
      if (!admin) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, admin.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const users = await storage.getUsersBySchool(sessionSchoolId);
      const staff = users
        .filter((user) => user.role === "teacher" || user.role === "school_admin")
        .map((user) => ({
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          schoolName: user.schoolName,
        }));

      res.json({ success: true, users: staff });
    } catch (error) {
      console.error("Get admin users error:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  app.post("/api/admin/users", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireSchoolAdminRole, async (req, res) => {
    try {
      const admin = await storage.getUser(req.session.userId!);
      if (!admin) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, admin.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const schoolId = sessionSchoolId;
      const data = adminUserCreateSchema.parse(req.body);

      const school = await storage.getSchool(schoolId);
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }
      assertEmailMatchesDomain(data.email, school.domain);

      const normalizedEmail = normalizeEmail(data.email) ?? data.email;
      const existing = await storage.getUserByEmail(normalizedEmail);
      if (existing) {
        return res.status(400).json({ error: "Email already exists" });
      }

      let password: string | null = null;
      if (data.password && data.password.trim().length > 0) {
        password = await bcrypt.hash(data.password, 10);
      }

      const created = await storage.createUser({
        email: normalizedEmail,
        username: normalizedEmail,
        password,
        role: data.role,
        schoolId,
        displayName: data.name ?? null,
        schoolName: admin.schoolName ?? school.name,
      });

      res.json({
        success: true,
        user: {
          id: created.id,
          email: created.email,
          displayName: created.displayName,
          role: created.role,
          schoolName: created.schoolName,
        },
      });
    } catch (error: any) {
      console.error("Create admin user error:", error);
      if (error.errors) {
        res.status(400).json({ error: error.errors[0].message });
      } else if (error instanceof EmailDomainError) {
        res.status(error.status).json({ error: error.message });
      } else {
        res.status(500).json({ error: "Failed to create user" });
      }
    }
  });

  app.patch("/api/admin/users/:userId", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireSchoolAdminRole, async (req, res) => {
    try {
      const { userId } = req.params;
      const admin = await storage.getUser(req.session.userId!);
      if (!admin) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, admin.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const targetUser = await storage.getUser(userId);
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }
      if (!assertSameSchool(sessionSchoolId, targetUser.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const data = adminUserUpdateSchema.parse(req.body);
      const nextRole = data.role ?? targetUser.role;
      if (targetUser.role === "school_admin" && nextRole === "teacher") {
        const adminCount = await countSchoolAdmins(storage, sessionSchoolId);
        if (adminCount <= 1) {
          return res.status(400).json({ error: "Cannot demote the last school admin" });
        }
      }

      const updated = await storage.updateUser(userId, {
        role: data.role,
        displayName: data.name ?? undefined,
      });

      res.json({
        success: true,
        user: {
          id: updated?.id ?? targetUser.id,
          email: updated?.email ?? targetUser.email,
          displayName: updated?.displayName ?? targetUser.displayName,
          role: updated?.role ?? targetUser.role,
          schoolName: updated?.schoolName ?? targetUser.schoolName,
        },
      });
    } catch (error: any) {
      console.error("Update admin user error:", error);
      if (error.errors) {
        res.status(400).json({ error: error.errors[0].message });
      } else {
        res.status(500).json({ error: "Failed to update user" });
      }
    }
  });

  app.delete("/api/admin/users/:userId", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireSchoolAdminRole, async (req, res) => {
    try {
      const { userId } = req.params;
      const admin = await storage.getUser(req.session.userId!);
      if (!admin) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, admin.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const targetUser = await storage.getUser(userId);
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }
      if (!assertSameSchool(sessionSchoolId, targetUser.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      if (targetUser.role === "school_admin") {
        const adminCount = await countSchoolAdmins(storage, sessionSchoolId);
        if (adminCount <= 1) {
          return res.status(400).json({ error: "Cannot delete the last school admin" });
        }
      }

      await storage.deleteUser(userId);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete admin user error:", error);
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  // Admin routes for managing teachers
  app.get("/api/admin/teachers", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const admin = await storage.getUser(req.session.userId!);
      if (!admin) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, admin.schoolId)) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get only users from the same school
      const users = await storage.getUsersBySchool(sessionSchoolId);
      
      // Filter to teachers and school_admins (admins can also teach) and remove passwords
      const teachers = users
        .filter(user => user.role === 'teacher' || user.role === 'school_admin')
        .map(user => ({
          id: user.id,
          username: user.username,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          schoolName: user.schoolName,
        }));
      res.json({ success: true, teachers });
    } catch (error) {
      console.error("Get teachers error:", error);
      res.status(500).json({ error: "Failed to fetch teachers" });
    }
  });

  app.post("/api/admin/teachers", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const admin = await storage.getUser(req.session.userId!);
      if (!admin) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, admin.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const schoolId = sessionSchoolId;

      const data = createTeacherSchema.parse(req.body);

      if (data.schoolId && data.schoolId !== schoolId) {
        return res.status(403).json({ error: "Cannot create users for another school" });
      }

      const school = await storage.getSchool(schoolId);
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }
      assertEmailMatchesDomain(data.email, school.domain);
      
      // Check if email already exists
      const existing = await storage.getUserByEmail(data.email);
      if (existing) {
        return res.status(400).json({ error: "Email already exists" });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(data.password, 10);
      
      // Create teacher with admin's schoolId (enforce tenant isolation)
      const teacher = await storage.createUser({
        email: data.email,
        username: data.email, // Use email as username
        password: hashedPassword,
        role: 'teacher',
        schoolId, // Use admin's schoolId, not from request
        displayName: data.displayName,
        schoolName: admin.schoolName || data.schoolName,
      });

      res.json({ 
        success: true, 
        teacher: {
          id: teacher.id,
          username: teacher.username,
          email: teacher.email,
          displayName: teacher.displayName,
          role: teacher.role,
          schoolName: teacher.schoolName,
        }
      });
    } catch (error: any) {
      console.error("Create teacher error:", error);
      if (error.errors) {
        // Zod validation error
        res.status(400).json({ error: error.errors[0].message });
      } else if (error instanceof EmailDomainError) {
        res.status(error.status).json({ error: error.message });
      } else {
        res.status(500).json({ error: "Failed to create teacher" });
      }
    }
  });

  app.delete("/api/admin/teachers/:id", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const { id } = req.params;
      const admin = await storage.getUser(req.session.userId!);
      if (!admin) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, admin.schoolId)) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Don't allow deleting yourself
      if (id === req.session.userId) {
        return res.status(400).json({ error: "Cannot delete your own account" });
      }

      // Verify the user exists and is a teacher (not an admin)
      const user = await storage.getUser(id);
      if (!user) {
        return res.status(404).json({ error: "Teacher not found" });
      }
      
      // Verify the teacher belongs to the same school (tenant isolation)
      if (!assertSameSchool(sessionSchoolId, user.schoolId)) {
        return res.status(404).json({ error: "Teacher not found" });
      }
      
      if (user.role === 'admin' || user.role === 'school_admin') {
        return res.status(403).json({ error: "Cannot delete admin accounts" });
      }

      await storage.deleteUser(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete teacher error:", error);
      res.status(500).json({ error: "Failed to delete teacher" });
    }
  });

  app.post("/api/admin/users/:userId/password", requireAuth, requireSchoolAdminRole, requireSchoolContext, requireActiveSchoolMiddleware, async (req, res) => {
    try {
      const { userId } = req.params;
      const admin = await storage.getUser(req.session.userId!);
      if (!admin) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, admin.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const data = adminResetPasswordSchema.parse(req.body);

      const targetUser = await storage.getUser(userId);
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }
      if (!assertSameSchool(sessionSchoolId, targetUser.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const hashedPassword = await bcrypt.hash(data.newPassword, 10);
      await storage.updateUser(userId, { password: hashedPassword });

      res.json({ ok: true });
    } catch (error: any) {
      if (error.errors) {
        res.status(400).json({ error: error.errors[0].message });
      } else {
        console.error("Admin reset password error:", error);
        res.status(500).json({ error: "Failed to reset password" });
      }
    }
  });

  // ====== AUDIT LOGS ======

  // Get audit logs for the school (school admin only)
  app.get("/api/admin/audit-logs", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireSchoolAdminRole, apiLimiter, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId;

      if (!sessionSchoolId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { action, userId, since, until, limit, offset } = req.query;

      const options: {
        action?: string;
        userId?: string;
        since?: Date;
        until?: Date;
        limit?: number;
        offset?: number;
      } = {};

      if (typeof action === 'string' && action) options.action = action;
      if (typeof userId === 'string' && userId) options.userId = userId;
      if (typeof since === 'string' && since) options.since = new Date(since);
      if (typeof until === 'string' && until) options.until = new Date(until);
      if (typeof limit === 'string' && limit) options.limit = parseInt(limit, 10);
      if (typeof offset === 'string' && offset) options.offset = parseInt(offset, 10);

      const result = await storage.getAuditLogsBySchool(sessionSchoolId, options);

      res.json(result);
    } catch (error) {
      console.error("Get audit logs error:", error);
      res.status(500).json({ error: "Failed to get audit logs" });
    }
  });

  // ====== ANALYTICS ENDPOINTS ======

  // Get school-wide analytics summary
  app.get("/api/admin/analytics/summary", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireSchoolAdminRole, apiLimiter, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId;
      if (!sessionSchoolId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { period = '24h' } = req.query;

      // Calculate time range
      let cutoffTime: number;
      switch (period) {
        case '7d':
          cutoffTime = Date.now() - (7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          cutoffTime = Date.now() - (30 * 24 * 60 * 60 * 1000);
          break;
        default: // 24h
          cutoffTime = Date.now() - (24 * 60 * 60 * 1000);
      }

      const [students, devices, heartbeats, teachers] = await Promise.all([
        storage.getStudentsBySchool(sessionSchoolId),
        storage.getDevicesBySchool(sessionSchoolId),
        storage.getHeartbeatsBySchool(sessionSchoolId),
        storage.getUsersBySchool(sessionSchoolId),
      ]);

      // Filter heartbeats by time range
      const recentHeartbeats = heartbeats.filter(hb =>
        new Date(hb.timestamp).getTime() >= cutoffTime
      );

      // Count active students (those with heartbeats in period)
      const activeStudentIds = new Set(recentHeartbeats.map(hb => hb.studentId).filter(Boolean));

      // Calculate total browsing time (approx 10s per heartbeat)
      const totalBrowsingMinutes = Math.round((recentHeartbeats.length * 10) / 60);

      // Top websites
      const urlCounts = new Map<string, number>();
      for (const hb of recentHeartbeats) {
        if (!hb.activeTabUrl) continue;
        try {
          const url = new URL(hb.activeTabUrl);
          let domain = url.hostname.replace(/^www\./, '');
          const count = urlCounts.get(domain) || 0;
          urlCounts.set(domain, count + 1);
        } catch { /* skip invalid URLs */ }
      }

      const topWebsites = Array.from(urlCounts.entries())
        .map(([domain, count]) => ({ domain, visits: count, minutes: Math.round((count * 10) / 60) }))
        .sort((a, b) => b.visits - a.visits)
        .slice(0, 10);

      // Activity by hour (for the most recent 24 hours)
      const hourlyActivity: { hour: number; count: number }[] = [];
      const last24h = heartbeats.filter(hb =>
        new Date(hb.timestamp).getTime() >= Date.now() - (24 * 60 * 60 * 1000)
      );
      const hourCounts = new Map<number, number>();
      for (const hb of last24h) {
        const hour = new Date(hb.timestamp).getHours();
        hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
      }
      for (let i = 0; i < 24; i++) {
        hourlyActivity.push({ hour: i, count: hourCounts.get(i) || 0 });
      }

      res.json({
        summary: {
          totalStudents: students.length,
          activeStudents: activeStudentIds.size,
          totalDevices: devices.length,
          totalTeachers: teachers.filter(t => t.role === 'teacher').length,
          totalBrowsingMinutes,
          period,
        },
        topWebsites,
        hourlyActivity,
      });
    } catch (error) {
      console.error("Get analytics summary error:", error);
      res.status(500).json({ error: "Failed to get analytics" });
    }
  });

  // Get analytics by teacher
  app.get("/api/admin/analytics/by-teacher", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireSchoolAdminRole, apiLimiter, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId;
      if (!sessionSchoolId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { period = '7d' } = req.query;

      let cutoffTime: number;
      switch (period) {
        case '30d':
          cutoffTime = Date.now() - (30 * 24 * 60 * 60 * 1000);
          break;
        default: // 7d
          cutoffTime = Date.now() - (7 * 24 * 60 * 60 * 1000);
      }

      const [teachers, sessions, groups] = await Promise.all([
        storage.getUsersBySchool(sessionSchoolId),
        storage.getSessionsBySchool(sessionSchoolId),
        storage.getGroupsBySchool(sessionSchoolId),
      ]);

      // Get sessions in the time period
      const recentSessions = sessions.filter(s =>
        new Date(s.startTime).getTime() >= cutoffTime
      );

      // Build teacher stats
      const teacherStats = teachers
        .filter(t => t.role === 'teacher')
        .map(teacher => {
          const teacherSessions = recentSessions.filter(s => s.teacherId === teacher.id);
          const teacherGroups = groups.filter(g => g.teacherId === teacher.id);

          let totalSessionMinutes = 0;
          for (const session of teacherSessions) {
            const start = new Date(session.startTime).getTime();
            const end = session.endTime ? new Date(session.endTime).getTime() : Date.now();
            totalSessionMinutes += (end - start) / (1000 * 60);
          }

          return {
            id: teacher.id,
            name: teacher.displayName || teacher.email,
            email: teacher.email,
            sessionCount: teacherSessions.length,
            totalSessionMinutes: Math.round(totalSessionMinutes),
            groupCount: teacherGroups.length,
          };
        })
        .sort((a, b) => b.sessionCount - a.sessionCount);

      res.json({ teachers: teacherStats, period });
    } catch (error) {
      console.error("Get teacher analytics error:", error);
      res.status(500).json({ error: "Failed to get analytics" });
    }
  });

  // ====== SUPER ADMIN ROUTES ======

  // List all schools with search and filtering support
  app.get("/api/super-admin/schools", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { search, status, includeDeleted } = req.query;
      
      // Get all schools (with deleted if requested)
      let schools = await storage.getAllSchools(includeDeleted === 'true');
      
      // Apply search filter (name or domain) - only if search is not empty
      const searchTerm = typeof search === 'string' ? search.trim() : '';
      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        schools = schools.filter(school => 
          school.name.toLowerCase().includes(searchLower) ||
          school.domain.toLowerCase().includes(searchLower)
        );
      }
      
      // Apply status filter - only if status is not "all" or empty
      const statusFilter = typeof status === 'string' ? status.trim() : '';
      if (statusFilter && statusFilter !== 'all') {
        schools = schools.filter(school => school.status === statusFilter);
      }
      
      // Get counts for each school
      const schoolsWithCounts = await Promise.all(
        schools.map(async (school) => {
          const users = await storage.getUsersBySchool(school.id);
          const students = await storage.getStudentsBySchool(school.id);
          const teachers = users.filter(u => u.role === 'teacher');
          const admins = users.filter(u => u.role === 'school_admin');
          
          return {
            ...school,
            teacherCount: teachers.length,
            studentCount: students.length,
            adminCount: admins.length,
          };
        })
      );
      
      // Calculate summary stats
      const summary = {
        totalSchools: schoolsWithCounts.length,
        activeSchools: schoolsWithCounts.filter(s => s.status === 'active' && !s.deletedAt).length,
        trialSchools: schoolsWithCounts.filter(s => s.status === 'trial' && !s.deletedAt).length,
        suspendedSchools: schoolsWithCounts.filter(s => s.status === 'suspended').length,
        totalLicenses: schoolsWithCounts.reduce((sum, s) => sum + (s.maxLicenses || 0), 0),
        totalStudents: schoolsWithCounts.reduce((sum, s) => sum + s.studentCount, 0),
      };
      
      res.json({ success: true, schools: schoolsWithCounts, summary });
    } catch (error) {
      console.error("Get schools error:", error);
      res.status(500).json({ error: "Failed to fetch schools" });
    }
  });

  // Create a new school
  app.post("/api/super-admin/schools", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      // Validate request body
      const validation = createSchoolRequestSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ 
          error: "Invalid request data",
          details: validation.error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message,
          }))
        });
      }
      
      const data = validation.data;
      
      // Check if domain already exists
      const existing = await storage.getSchoolByDomain(data.domain);
      if (existing) {
        return res.status(400).json({ error: "School with this domain already exists" });
      }

      // Calculate trialEndsAt from trialDays if provided
      let trialEndsAt: Date | null = null;
      if (data.trialEndsAt) {
        trialEndsAt = new Date(data.trialEndsAt);
      } else if ((data as any).trialDays && (data.status || 'trial') === 'trial') {
        trialEndsAt = new Date();
        trialEndsAt.setDate(trialEndsAt.getDate() + Number((data as any).trialDays));
      }

      const school = await storage.createSchool({
        name: data.name,
        domain: data.domain,
        status: data.status || 'trial',
        maxLicenses: data.maxLicenses || 100,
        trialEndsAt,
        billingEmail: (data as any).billingEmail || null,
      });

      // If firstAdminEmail provided, create school admin user
      // User can log in via Google OAuth or email/password (if password provided)
      if (data.firstAdminEmail) {
        assertEmailMatchesDomain(data.firstAdminEmail, data.domain);
        // Hash password if provided
        let hashedPassword = null;
        if (data.firstAdminPassword && data.firstAdminPassword.trim().length > 0) {
          hashedPassword = await bcrypt.hash(data.firstAdminPassword, 10);
        }
        
        await storage.createUser({
          email: data.firstAdminEmail,
          password: hashedPassword, // Hashed password or null for Google OAuth only
          role: 'school_admin',
          schoolId: school.id,
          displayName: data.firstAdminName || data.firstAdminEmail.split('@')[0],
        });

        res.json({ 
          success: true, 
          school,
          adminCreated: true,
          adminEmail: data.firstAdminEmail,
          message: hashedPassword 
            ? 'Admin account created with password. User can sign in with Google or email/password.'
            : 'Admin account created. User should sign in with Google using their school email.',
        });
      } else {
        res.json({ success: true, school });
      }
    } catch (error) {
      console.error("Create school error:", error);
      if (error instanceof EmailDomainError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to create school" });
    }
  });

  // Get school details
  app.get("/api/super-admin/schools/:id", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { id } = req.params;
      const school = await storage.getSchool(id);
      
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }

      const users = await storage.getUsersBySchool(id);
      const students = await storage.getStudentsBySchool(id);
      
      const admins = users.filter(u => u.role === 'school_admin').map(u => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        createdAt: u.createdAt,
      }));
      
      const teachers = users.filter(u => u.role === 'teacher').map(u => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        createdAt: u.createdAt,
      }));

      res.json({ 
        success: true, 
        school: {
          ...school,
          teacherCount: teachers.length,
          studentCount: students.length,
          adminCount: admins.length,
        },
        admins,
        teachers,
      });
    } catch (error) {
      console.error("Get school error:", error);
      res.status(500).json({ error: "Failed to fetch school" });
    }
  });

  // Update school
  app.patch("/api/super-admin/schools/:id", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;

      const existingSchool = await storage.getSchool(id);
      if (!existingSchool) {
        return res.status(404).json({ error: "School not found" });
      }

      let school = await storage.updateSchool(id, updates);
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }

      if (updates.status === "suspended") {
        const refreshed = await storage.setSchoolActiveState(id, {
          isActive: false,
          planStatus: "canceled",
          disabledReason: "suspended",
        });
        if (refreshed) {
          school = refreshed;
        }
        closeSocketsForSchool(id);
      } else if (existingSchool.status === "suspended" && updates.status && updates.status !== "suspended") {
        const refreshed = await storage.setSchoolActiveState(id, {
          isActive: true,
          planStatus: "active",
          disabledReason: null,
        });
        if (refreshed) {
          school = refreshed;
        }
      }

      res.json({ success: true, school });
    } catch (error) {
      console.error("Update school error:", error);
      res.status(500).json({ error: "Failed to update school" });
    }
  });

  // Update school plan (manual entitlement controls)
  app.patch("/api/super-admin/schools/:schoolId/plan", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { schoolId } = req.params;
      const planUpdateSchema = z.object({
        planTier: z.enum(PLAN_TIER_ORDER).optional(),
        planStatus: z.enum(PLAN_STATUS_VALUES).optional(),
        activeUntil: z.union([z.string().datetime(), z.null()]).optional(),
      });

      const validation = planUpdateSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: "Invalid plan update" });
      }

      const existingSchool = await storage.getSchool(schoolId);
      if (!existingSchool) {
        return res.status(404).json({ error: "School not found" });
      }

      const updates: Partial<InsertSchool> = {};
      if (validation.data.planTier) {
        updates.planTier = validation.data.planTier;
      }
      if (validation.data.planStatus) {
        updates.planStatus = validation.data.planStatus;
      }
      if (validation.data.activeUntil !== undefined) {
        updates.activeUntil = validation.data.activeUntil ? new Date(validation.data.activeUntil) : null;
      }

      const updated = await storage.updateSchool(schoolId, updates);
      if (!updated) {
        return res.status(404).json({ error: "School not found" });
      }

      res.json({ success: true, school: updated });
    } catch (error) {
      console.error("Update school plan error:", error);
      res.status(500).json({ error: "Failed to update school plan" });
    }
  });

  // Soft delete school (sets deletedAt timestamp)
  app.delete("/api/super-admin/schools/:id", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { id } = req.params;
      
      const school = await storage.softDeleteSchool(id);
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }

      res.json({ success: true, school });
    } catch (error) {
      console.error("Soft delete school error:", error);
      res.status(500).json({ error: "Failed to delete school" });
    }
  });

  // Suspend school (sets status to 'suspended')
  app.post("/api/super-admin/schools/:id/suspend", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { id } = req.params;
      
      let school = await storage.updateSchool(id, { status: 'suspended' });
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }

      const refreshed = await storage.setSchoolActiveState(id, {
        isActive: false,
        planStatus: "canceled",
        disabledReason: "suspended",
      });
      if (refreshed) {
        school = refreshed;
      }
      closeSocketsForSchool(id);

      res.json({ success: true, school });
    } catch (error) {
      console.error("Suspend school error:", error);
      res.status(500).json({ error: "Failed to suspend school" });
    }
  });

  app.patch("/api/super-admin/schools/:id/deactivate", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { id } = req.params;

      const school = await storage.setSchoolActiveState(id, {
        isActive: false,
        planStatus: "canceled",
        disabledReason: "manual",
      });
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }
      closeSocketsForSchool(id);

      res.json({ success: true, school });
    } catch (error) {
      console.error("Deactivate school error:", error);
      res.status(500).json({ error: "Failed to deactivate school" });
    }
  });

  // Restore school (clears deletedAt timestamp)
  app.post("/api/super-admin/schools/:id/restore", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { id } = req.params;
      
      const school = await storage.restoreSchool(id);
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }

      res.json({ success: true, school });
    } catch (error) {
      console.error("Restore school error:", error);
      res.status(500).json({ error: "Failed to restore school" });
    }
  });

  // Impersonate a school admin (for support purposes)
  app.post("/api/super-admin/schools/:id/impersonate", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { id } = req.params;
      
      const school = await storage.getSchool(id);
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }

      // Find a school admin for this school
      const users = await storage.getUsersBySchool(id);
      const schoolAdmin = users.find(u => u.role === 'school_admin');
      
      if (!schoolAdmin) {
        return res.status(404).json({ error: "No school admin found for this school" });
      }

      // Store original super admin ID for audit trail
      const originalUserId = req.session.userId;
      
      console.log(`[IMPERSONATE] Super admin ${originalUserId} impersonating school admin ${schoolAdmin.id} for school ${school.name}`);

      // Switch session to the school admin
      req.session.userId = schoolAdmin.id;
      req.session.role = schoolAdmin.role;
      req.session.schoolId = schoolAdmin.schoolId ?? undefined;
      req.session.impersonating = true;
      req.session.originalUserId = originalUserId;

      res.json({ 
        success: true, 
        message: `Now impersonating ${schoolAdmin.displayName || schoolAdmin.email}`,
        admin: {
          id: schoolAdmin.id,
          email: schoolAdmin.email,
          displayName: schoolAdmin.displayName,
          schoolName: school.name,
        }
      });
    } catch (error) {
      console.error("Impersonate error:", error);
      res.status(500).json({ error: "Failed to impersonate admin" });
    }
  });

  // Stop impersonating and return to original super admin session
  // Note: This endpoint must allow impersonating sessions (super admin currently acting as school admin)
  app.post("/api/super-admin/stop-impersonate", requireAuth, async (req, res) => {
    try {
      // Verify user is authenticated
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      if (!req.session.impersonating || !req.session.originalUserId) {
        return res.status(400).json({ error: "Not currently impersonating" });
      }

      const originalUser = await storage.getUser(req.session.originalUserId);
      if (!originalUser || originalUser.role !== 'super_admin') {
        return res.status(403).json({ error: "Original session invalid" });
      }

      // Additional security check: verify the session userId matches either original or impersonated user
      if (req.session.userId !== originalUser.id && req.session.originalUserId !== originalUser.id) {
        return res.status(403).json({ error: "Session mismatch" });
      }

      console.log(`[STOP IMPERSONATE] Returning to super admin ${originalUser.id}`);

      // Restore original session
      req.session.userId = originalUser.id;
      req.session.role = originalUser.role;
      req.session.schoolId = undefined;
      req.session.impersonating = false;
      delete req.session.originalUserId;

      res.json({ success: true, message: "Stopped impersonating" });
    } catch (error) {
      console.error("Stop impersonate error:", error);
      res.status(500).json({ error: "Failed to stop impersonating" });
    }
  });

  // Reset login for school admin (generate temporary password)
  app.post("/api/super-admin/schools/:id/reset-login", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { id } = req.params;
      const { adminId } = req.body;
      
      const school = await storage.getSchool(id);
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }

      // Get the specific admin or find any school admin
      let admin;
      if (adminId) {
        admin = await storage.getUser(adminId);
        if (!admin || admin.schoolId !== id || admin.role !== 'school_admin') {
          return res.status(404).json({ error: "School admin not found" });
        }
      } else {
        // Find first school admin for this school
        const users = await storage.getUsersBySchool(id);
        admin = users.find(u => u.role === 'school_admin');
        if (!admin) {
          return res.status(404).json({ error: "No school admin found for this school" });
        }
      }

      // Generate cryptographically secure temporary password
      const tempPassword = generateSecurePassword(16);
      const hashedPassword = await bcrypt.hash(tempPassword, 10);

      // Update admin's password
      await storage.updateUser(admin.id, { password: hashedPassword });

      console.log(`[RESET LOGIN] Super admin ${req.session.userId} reset password for ${admin.email} at school ${school.name}`);

      // SECURITY: Password should be sent via secure email/SMS in production
      // For now, we return it but this should be changed to email delivery
      res.json({
        success: true,
        admin: {
          email: admin.email,
          displayName: admin.displayName,
        },
        message: `Temporary password generated and should be sent to ${admin.email}`,
        // TODO: Remove tempPassword from response once email delivery is implemented
        tempPassword
      });
    } catch (error) {
      console.error("Reset login error:", error);
      res.status(500).json({ error: "Failed to reset login" });
    }
  });

  // Send onboarding email to all school admins
  app.post("/api/super-admin/schools/:id/send-onboarding-email", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { id } = req.params;
      const school = await storage.getSchool(id);

      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }

      const allUsers = await storage.getUsersBySchool(id);
      const admins = allUsers.filter(u => u.role === "school_admin");

      if (admins.length === 0) {
        return res.status(400).json({ error: "No admins found for this school" });
      }

      const { sendOnboardingEmail } = await import("./util/email");
      const loginUrl = `https://school-pilot.net/login`;

      let sent = 0;
      let failed = 0;

      for (const admin of admins) {
        const success = await sendOnboardingEmail({
          schoolName: school.name,
          adminEmail: admin.email,
          adminName: admin.displayName || admin.email,
          loginUrl,
        });
        if (success) sent++;
        else failed++;
      }

      res.json({ success: true, sent, failed });
    } catch (error) {
      console.error("Send onboarding email error:", error);
      res.status(500).json({ error: "Failed to send onboarding emails" });
    }
  });

  // Add admin to school
  app.post("/api/super-admin/schools/:id/admins", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { id } = req.params;
      const { email, displayName } = req.body;

      const school = await storage.getSchool(id);
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }

      // Check if user already exists
      const existing = await storage.getUserByEmail(email);
      if (existing) {
        return res.status(400).json({ error: "User with this email already exists" });
      }

      assertEmailMatchesDomain(email, school.domain);

      const tempPassword = generateSecurePassword(16);
      const hashedPassword = await bcrypt.hash(tempPassword, 10);

      const admin = await storage.createUser({
        email,
        password: hashedPassword,
        role: 'school_admin',
        schoolId: id,
        displayName: displayName || email.split('@')[0],
      });

      // SECURITY: Password should be sent via secure email/SMS in production
      res.json({
        success: true,
        admin: {
          id: admin.id,
          email: admin.email,
          displayName: admin.displayName,
        },
        message: `Admin created. Temporary password should be sent to ${admin.email}`,
        // TODO: Remove tempPassword from response once email delivery is implemented
        tempPassword
      });
    } catch (error) {
      console.error("Add admin error:", error);
      if (error instanceof EmailDomainError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to add admin" });
    }
  });

  // ====== TRIAL REQUESTS MANAGEMENT (Super Admin) ======

  // Get all trial requests
  app.get("/api/super-admin/trial-requests", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { status } = req.query;

      let query = db.select().from(trialRequests).orderBy(sql`${trialRequests.createdAt} DESC`);

      if (status && status !== 'all') {
        const requests = await db.select()
          .from(trialRequests)
          .where(sql`${trialRequests.status} = ${status}`)
          .orderBy(sql`${trialRequests.createdAt} DESC`);
        return res.json(requests);
      }

      const requests = await query;
      res.json(requests);
    } catch (error) {
      console.error("Get trial requests error:", error);
      res.status(500).json({ error: "Failed to get trial requests" });
    }
  });

  // Update trial request status
  app.patch("/api/super-admin/trial-requests/:id", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { id } = req.params;
      const { status, notes } = req.body;

      const validStatuses = ['pending', 'contacted', 'converted', 'declined'];
      if (status && !validStatuses.includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      const [updated] = await db.update(trialRequests)
        .set({
          status: status || undefined,
          notes: notes !== undefined ? notes : undefined,
          processedAt: new Date(),
          processedBy: req.session.userId,
        })
        .where(sql`${trialRequests.id} = ${id}`)
        .returning();

      if (!updated) {
        return res.status(404).json({ error: "Trial request not found" });
      }

      res.json(updated);
    } catch (error) {
      console.error("Update trial request error:", error);
      res.status(500).json({ error: "Failed to update trial request" });
    }
  });

  // Delete trial request
  app.delete("/api/super-admin/trial-requests/:id", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { id } = req.params;

      const result = await db.delete(trialRequests)
        .where(sql`${trialRequests.id} = ${id}`)
        .returning();

      if (result.length === 0) {
        return res.status(404).json({ error: "Trial request not found" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Delete trial request error:", error);
      res.status(500).json({ error: "Failed to delete trial request" });
    }
  });

  // ── Stripe: Create Checkout Session (self-service) ──
  app.post("/api/checkout/create-session", async (req, res) => {
    try {
      const { studentCount, skipTrial, schoolName, billingEmail } = req.body;
      if (!studentCount || !billingEmail || !schoolName) {
        return res.status(400).json({ error: "studentCount, schoolName, and billingEmail are required" });
      }

      const baseUrl = getBaseUrl();
      const url = await createCheckoutSession({
        schoolId: req.body.schoolId || "pending",
        schoolName,
        studentCount: Number(studentCount),
        skipTrial: !!skipTrial,
        billingEmail,
        successUrl: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${baseUrl}/pricing`,
      });

      res.json({ url });
    } catch (error) {
      console.error("Create checkout session error:", error);
      res.status(500).json({ error: "Failed to create checkout session" });
    }
  });

  // ── Stripe: Webhook ──
  app.post("/api/stripe/webhook", async (req, res) => {
    try {
      const signature = req.headers["stripe-signature"] as string;
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!webhookSecret) {
        console.error("STRIPE_WEBHOOK_SECRET not configured");
        return res.status(500).json({ error: "Webhook not configured" });
      }

      if (!req.rawBody) {
        return res.status(400).json({ error: "Missing raw body" });
      }

      const event = constructWebhookEvent(req.rawBody, signature, webhookSecret);
      await handleWebhookEvent(event);

      res.json({ received: true });
    } catch (error: any) {
      console.error("Stripe webhook error:", error.message);
      res.status(400).json({ error: `Webhook Error: ${error.message}` });
    }
  });

  // ── Stripe: Super Admin Send Invoice ──
  app.post("/api/super-admin/schools/:id/send-invoice", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { id } = req.params;
      const school = await storage.getSchool(id);
      if (!school) return res.status(404).json({ error: "School not found" });

      const {
        studentCount,
        basePrice = 500,
        perStudentPrice = 2,
        description,
        daysUntilDue = 30,
        billingEmail,
      } = req.body;

      if (!studentCount || studentCount < 1) {
        return res.status(400).json({ error: "studentCount is required and must be >= 1" });
      }

      const email = billingEmail || school.billingEmail;
      if (!email) {
        return res.status(400).json({ error: "No billing email set for this school" });
      }

      const result = await createCustomInvoice({
        schoolId: id,
        schoolName: school.name,
        billingEmail: email,
        stripeCustomerId: school.stripeCustomerId,
        studentCount: Number(studentCount),
        basePrice: Number(basePrice),
        perStudentPrice: Number(perStudentPrice),
        description,
        daysUntilDue: Number(daysUntilDue),
      });

      // Update billing email if provided
      if (billingEmail && billingEmail !== school.billingEmail) {
        await storage.updateSchool(id, { billingEmail });
      }

      res.json({
        success: true,
        invoiceId: result.invoiceId,
        invoiceUrl: result.invoiceUrl,
      });
    } catch (error) {
      console.error("Send invoice error:", error);
      res.status(500).json({ error: "Failed to send invoice" });
    }
  });

  // ── Stripe: Super Admin Get Billing Info ──
  app.get("/api/super-admin/schools/:id/billing", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { id } = req.params;
      const school = await storage.getSchool(id);
      if (!school) return res.status(404).json({ error: "School not found" });

      // Get recent invoices from Stripe if customer exists
      let invoices: any[] = [];
      if (school.stripeCustomerId && stripeClient) {
        try {
          const stripeInvoices = await stripeClient.invoices.list({
            customer: school.stripeCustomerId,
            limit: 10,
          });
          invoices = stripeInvoices.data.map((inv) => ({
            id: inv.id,
            amount: inv.amount_paid,
            status: inv.status,
            created: inv.created,
            hostedUrl: inv.hosted_invoice_url,
            pdfUrl: inv.invoice_pdf,
            description: inv.description,
          }));
        } catch (e) {
          console.error("Error fetching Stripe invoices:", e);
        }
      }

      res.json({
        billingEmail: school.billingEmail,
        stripeCustomerId: school.stripeCustomerId,
        planStatus: school.planStatus,
        planTier: school.planTier,
        status: school.status,
        activeUntil: school.activeUntil,
        trialEndsAt: school.trialEndsAt,
        maxLicenses: school.maxLicenses,
        lastPaymentAmount: school.lastPaymentAmount,
        lastPaymentDate: school.lastPaymentDate,
        totalPaid: school.totalPaid,
        invoices,
      });
    } catch (error) {
      console.error("Get billing info error:", error);
      res.status(500).json({ error: "Failed to get billing info" });
    }
  });

  // ── Super Admin: Broadcast Email to All School Admins ──
  app.post("/api/super-admin/broadcast-email", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const { subject, message } = req.body;

      if (!subject || !message) {
        return res.status(400).json({ error: "Subject and message are required" });
      }

      // Get all school admins from active/trial schools
      const schools = await storage.getAllSchools();
      const activeSchools = schools.filter(s => s.status === "active" || s.status === "trial");

      const recipients: Array<{ email: string; name?: string | null; schoolName?: string }> = [];

      for (const school of activeSchools) {
        const admins = await storage.getSchoolAdmins(school.id);
        for (const admin of admins) {
          recipients.push({
            email: admin.email,
            name: admin.displayName,
            schoolName: school.name,
          });
        }
      }

      if (recipients.length === 0) {
        return res.status(400).json({ error: "No active school admins found" });
      }

      const { sendBroadcastEmail } = await import("./util/email");
      const result = await sendBroadcastEmail({ subject, message, recipients });

      res.json({
        success: true,
        sent: result.sent,
        failed: result.failed,
        totalRecipients: recipients.length,
        errors: result.errors.length > 0 ? result.errors : undefined,
      });
    } catch (error) {
      console.error("Broadcast email error:", error);
      res.status(500).json({ error: "Failed to send broadcast email" });
    }
  });

  // ── Super Admin: Get All Admin Emails (for preview) ──
  app.get("/api/super-admin/admin-emails", requireAuth, requireSuperAdminRole, async (req, res) => {
    try {
      const schools = await storage.getAllSchools();
      const activeSchools = schools.filter(s => s.status === "active" || s.status === "trial");

      const adminsBySchool: Array<{
        schoolId: string;
        schoolName: string;
        status: string;
        admins: Array<{ email: string; name?: string | null }>;
      }> = [];

      let totalAdmins = 0;

      for (const school of activeSchools) {
        const admins = await storage.getSchoolAdmins(school.id);
        if (admins.length > 0) {
          adminsBySchool.push({
            schoolId: school.id,
            schoolName: school.name,
            status: school.status,
            admins: admins.map(a => ({ email: a.email, name: a.displayName })),
          });
          totalAdmins += admins.length;
        }
      }

      res.json({
        success: true,
        totalAdmins,
        schoolCount: adminsBySchool.length,
        adminsBySchool,
      });
    } catch (error) {
      console.error("Get admin emails error:", error);
      res.status(500).json({ error: "Failed to get admin emails" });
    }
  });

  // Admin: Get all teacher-student assignments
  app.get("/api/admin/teacher-students", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      // Get only users and students from the same school (tenant isolation)
      const users = await storage.getUsersBySchool(sessionSchoolId);
      const students = await storage.getStudentsBySchool(sessionSchoolId);
      
      // Get assignments for each teacher
      const teachers = users.filter(user => user.role === 'teacher');
      const assignments = [];
      
      for (const teacher of teachers) {
        const studentIds = await storage.getTeacherStudents(teacher.id);
        assignments.push({
          teacherId: teacher.id,
          teacherName: teacher.username,
          studentIds,
        });
      }
      
      res.json({ 
        success: true, 
        teachers: teachers.map(t => ({
          id: t.id,
          username: t.username,
          email: t.email,
          displayName: t.displayName,
          schoolName: t.schoolName,
        })),
        students: students.map(s => ({
          id: s.id,
          studentName: s.studentName,
          studentEmail: s.studentEmail,
          gradeLevel: s.gradeLevel,
          deviceId: s.deviceId,
        })),
        assignments,
      });
    } catch (error) {
      console.error("Get teacher-students error:", error);
      res.status(500).json({ error: "Failed to fetch teacher-student assignments" });
    }
  });

  // Admin: Assign students to a teacher
  app.post("/api/admin/teacher-students/:teacherId", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      const { teacherId } = req.params;
      const { studentIds } = req.body;
      
      if (!Array.isArray(studentIds)) {
        return res.status(400).json({ error: "studentIds must be an array" });
      }
      
      // Verify teacher exists and belongs to same school (tenant isolation)
      const teacher = await storage.getUser(teacherId);
      if (!teacher || teacher.role !== 'teacher') {
        return res.status(404).json({ error: "Teacher not found" });
      }
      
      if (!assertSameSchool(sessionSchoolId, teacher.schoolId)) {
        return res.status(404).json({ error: "Teacher not found" });
      }
      
      // Verify all students belong to same school (tenant isolation)
      const allStudents = await storage.getStudentsBySchool(sessionSchoolId);
      for (const studentId of studentIds) {
        const student = allStudents.find(s => s.id === studentId);
        if (!student) {
          return res.status(404).json({ error: "Student not found" });
        }
        if (!assertSameSchool(sessionSchoolId, student.schoolId)) {
          return res.status(404).json({ error: "Student not found" });
        }
      }
      
      // Get current assignments
      const currentStudentIds = await storage.getTeacherStudents(teacherId);
      
      // Find students to add and remove
      const toAdd = studentIds.filter(id => !currentStudentIds.includes(id));
      const toRemove = currentStudentIds.filter(id => !studentIds.includes(id));
      
      // Add new assignments
      for (const studentId of toAdd) {
        await storage.assignStudentToTeacher(teacherId, studentId);
      }
      
      // Remove old assignments
      for (const studentId of toRemove) {
        await storage.unassignStudentFromTeacher(teacherId, studentId);
      }
      
      res.json({ 
        success: true, 
        added: toAdd.length,
        removed: toRemove.length,
        message: `Updated assignments for ${teacher.username}`,
      });
    } catch (error) {
      console.error("Assign students error:", error);
      res.status(500).json({ error: "Failed to assign students to teacher" });
    }
  });

  // Admin: Remove a student from a teacher
  app.delete("/api/admin/teacher-students/:teacherId/:studentId", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const { teacherId, studentId } = req.params;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      const teacher = await storage.getUser(teacherId);
      if (!teacher) {
        return res.status(404).json({ error: "Teacher not found" });
      }
      if (!assertSameSchool(sessionSchoolId, teacher.schoolId)) {
        return res.status(404).json({ error: "Teacher not found" });
      }

      const student = await storage.getStudent(studentId);
      if (!student) {
        return res.status(404).json({ error: "Student not found" });
      }
      if (!assertSameSchool(sessionSchoolId, student.schoolId)) {
        return res.status(404).json({ error: "Student not found" });
      }
      
      const success = await storage.unassignStudentFromTeacher(teacherId, studentId);
      
      if (!success) {
        return res.status(404).json({ error: "Assignment not found" });
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Remove student assignment error:", error);
      res.status(500).json({ error: "Failed to remove student assignment" });
    }
  });

  // Admin: Clean up all student data
  app.post("/api/admin/cleanup-students", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      // Delete all students (student assignments)
      const allStudents = await storage.getStudentsBySchool(sessionSchoolId);
      for (const student of allStudents) {
        await storage.deleteStudent(student.id);
      }
      
      // Delete all devices
      const allDevices = await storage.getDevicesBySchool(sessionSchoolId);
      for (const device of allDevices) {
        await storage.deleteDevice(device.deviceId);
      }
      
      // Notify all connected teachers
      broadcastToTeachers(sessionSchoolId, {
        type: 'students-cleared',
      });
      
      res.json({ success: true, message: 'All student data cleared successfully' });
    } catch (error) {
      console.error("Cleanup error:", error);
      res.status(500).json({ error: "Failed to cleanup student data" });
    }
  });

  // Admin: Migrate existing teacher_students to groups system
  app.post("/api/admin/migrate-to-groups", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      // Get all teachers in this school
      const allTeachers = (await storage.getUsersBySchool(sessionSchoolId)).filter(user => user.role === 'teacher');
      
      let groupsCreated = 0;
      let studentsAssigned = 0;
      
      // For each teacher, create a default group and assign students
      for (const teacher of allTeachers) {
        // Get teacher's assigned students
        const studentIds = await storage.getTeacherStudents(teacher.id);
        if (studentIds.length === 0) continue;
        
        // Check if teacher already has a default group
        const existingGroups = await storage.getGroupsByTeacher(teacher.id);
        let defaultGroup = existingGroups.find(g => g.name === 'All Students');
        
        // Create default group if it doesn't exist
        if (!defaultGroup) {
          defaultGroup = await storage.createGroup({
            teacherId: teacher.id,
            schoolId: sessionSchoolId,
            name: 'All Students',
            description: 'Default group containing all assigned students',
          });
          groupsCreated++;
        }
        
        // Assign all students to the default group
        for (const studentId of studentIds) {
          try {
            await storage.assignStudentToGroup(defaultGroup.id, studentId);
            studentsAssigned++;
          } catch (error) {
            // Student might already be assigned, skip
            console.log(`Student ${studentId} already in group ${defaultGroup.id}`);
          }
        }
      }
      
      res.json({
        success: true,
        message: 'Migration completed successfully',
        teachersProcessed: allTeachers.length,
        groupsCreated,
        studentsAssigned,
      });
    } catch (error) {
      console.error("Migration error:", error);
      res.status(500).json({ error: "Failed to migrate to groups system" });
    }
  });

  // Admin: Bulk import students from CSV
  app.post("/api/admin/bulk-import", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const { fileContent } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      if (!fileContent || typeof fileContent !== "string") {
        return res.status(400).json({ error: "CSV file content is required" });
      }

      // Security: Limit CSV file size to prevent DoS attacks
      const MAX_CSV_SIZE = 10 * 1024 * 1024; // 10MB
      if (fileContent.length > MAX_CSV_SIZE) {
        return res.status(413).json({
          error: `CSV file too large. Maximum size is ${MAX_CSV_SIZE / 1024 / 1024}MB`,
        });
      }

      let data: Record<string, string>[];
      try {
        data = parseCsv(fileContent, {
          requiredHeaders: ["Email", "Name"],
          optionalHeaders: ["Grade", "Class"],
        });
      } catch (error) {
        return res.status(400).json({
          error: error instanceof Error ? error.message : "Invalid CSV file",
        });
      }

      if (data.length === 0) {
        return res.status(400).json({ error: "File is empty" });
      }

      // Get settings for schoolId and deviceId generation
      const allGroups = await storage.getGroupsBySchool(sessionSchoolId);

      const results = {
        total: data.length,
        created: 0,
        updated: 0,
        assigned: 0,
        errors: [] as string[],
        warnings: [] as string[],
      };

      // Process each row
      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const rowNum = i + 2; // Account for header row and 0-indexing

        try {
          // Extract and validate fields
          const email = row.Email?.trim() ?? "";
          const name = row.Name?.trim() ?? "";
          const grade = row.Grade?.trim() ?? "";
          const className = row.Class?.trim() ?? "";

          // Validate required fields
          if (!email) {
            results.errors.push(`Row ${rowNum}: Email is required`);
            continue;
          }

          if (!name) {
            results.errors.push(`Row ${rowNum}: Name is required`);
            continue;
          }

          // Validate email format
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(email)) {
            results.errors.push(`Row ${rowNum}: Invalid email format for ${email}`);
            continue;
          }

          // Normalize grade level
          const normalizedGrade = normalizeGradeLevel(grade) || null;

          // Check if student already exists by email
          const allStudents = await storage.getStudentsBySchool(sessionSchoolId);
          let student = allStudents.find(s => s.studentEmail?.toLowerCase() === email.toLowerCase());

          if (student) {
            // Update existing student's name and grade if different
            const needsUpdate = student.studentName !== name || student.gradeLevel !== normalizedGrade;
            
            if (needsUpdate) {
              // Update student record
              await storage.updateStudent(student.id, {
                studentName: name,
                gradeLevel: normalizedGrade,
              });
              results.updated++;
            }
          } else {
            // Create new student with a placeholder deviceId
            // When the student logs in via extension, their deviceId will be updated
            const placeholderDeviceId = `pending-${email.replace(/[^a-zA-Z0-9]/g, '-')}`;
            
            // Check if device exists, create if not
            let device = await storage.getDevice(placeholderDeviceId);
            if (!device) {
              device = await storage.registerDevice({
                deviceId: placeholderDeviceId,
                deviceName: `Pending: ${name}`,
                classId: 'pending',
                schoolId: sessionSchoolId,
              });
            }

            student = await storage.createStudent({
              deviceId: placeholderDeviceId,
              studentName: name,
              studentEmail: email,
              emailLc: normalizeEmail(email), // Normalized: lowercase + strip +tags
              gradeLevel: normalizedGrade,
              schoolId: sessionSchoolId,
              studentStatus: "active", // Default status for CSV imports
            });
            results.created++;
          }

          // Assign to class if className is provided
          if (className && student) {
            const group = allGroups.find(g => g.name.toLowerCase() === className.toLowerCase());
            
            if (group) {
              try {
                await storage.assignStudentToGroup(group.id, student.id);
                results.assigned++;
              } catch (error) {
                // Student might already be in the group
                results.warnings.push(`Row ${rowNum}: ${name} may already be assigned to ${className}`);
              }
            } else {
              results.warnings.push(`Row ${rowNum}: Class "${className}" not found for ${name}`);
            }
          }

        } catch (error: any) {
          if (isLicenseLimitError(error)) {
            return res.status(409).json({
              ...buildLicenseLimitResponse(error),
              results,
            });
          }
          results.errors.push(`Row ${rowNum}: ${error.message || 'Unknown error'}`);
        }
      }

      // Notify all connected teachers of the update
      broadcastToTeachers(sessionSchoolId, {
        type: 'students-updated',
      });

      res.json({
        success: true,
        message: 'Bulk import completed',
        results,
      });
    } catch (error) {
      console.error("Bulk import error:", error);
      res.status(500).json({ error: "Failed to process bulk import" });
    }
  });

  // Device registration (from extension) - DEPRECATED: Use /api/register-student instead
  // This endpoint is kept for backward compatibility only
  app.post("/api/register", apiLimiter, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const { deviceId, deviceName, classId, schoolId } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      // Require schoolId - no defaults allowed (prevents default-school issues)
      if (!schoolId) {
        return res.status(400).json({ 
          error: "schoolId is required. Use /api/register-student for automatic school routing." 
        });
      }
      if (!assertSameSchool(sessionSchoolId, schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      
      // Validate device data
      const deviceData = insertDeviceSchema.parse({
        deviceId,
        deviceName,
        classId,
        schoolId,
      });
      
      // Check if device already exists
      const existing = await storage.getDevice(deviceData.deviceId);
      if (existing) {
        // Return existing device with its assigned students
        const students = await storage.getStudentsByDevice(sessionSchoolId, deviceData.deviceId);
        return res.json({ success: true, device: existing, students });
      }

      const device = await storage.registerDevice(deviceData);
      
      // Notify teachers
      broadcastToTeachers(sessionSchoolId, {
        type: 'device-registered',
        data: device,
      });

      res.json({ success: true, device, students: [] });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // PUBLIC: Extension self-registration endpoint (no teacher auth required)
  // This allows the Chrome extension to register students directly using their Google account email
  app.post("/api/extension/register", apiLimiter, async (req, res) => {
    try {
      const { deviceId, deviceName, studentEmail, studentName } = req.body;

      // Validate required fields
      if (!studentEmail || !studentName) {
        return res.status(400).json({ error: "studentEmail and studentName are required" });
      }

      if (!deviceId) {
        return res.status(400).json({ error: "deviceId is required" });
      }

      // Look up school by email domain
      const schoolInfo = await getSchoolFromEmail(storage, studentEmail);
      if (!schoolInfo) {
        const domain = studentEmail.split('@')[1];
        console.error('[extension/register] No school found for domain:', domain);
        return res.status(401).json({
          error: "Unauthorized",
          details: `No school configured for domain: ${domain}`
        });
      }

      const { schoolId, schoolName } = schoolInfo;
      console.log('[extension/register] Found school:', schoolName, 'for email:', studentEmail);

      // Check if school is active
      const school = await storage.getSchool(schoolId);
      if (!school || !school.isActive || school.planStatus !== 'active') {
        return res.status(403).json({ error: "School is not active" });
      }

      // Register or update device
      const deviceData = insertDeviceSchema.parse({
        deviceId,
        deviceName: deviceName || null,
        classId: schoolId,
        schoolId,
      });

      let device = await storage.getDevice(deviceData.deviceId);
      if (!device) {
        device = await storage.registerDevice(deviceData);
        console.log('[extension/register] Created new device:', deviceId);
      }

      // Check if student exists or create new one
      const normalizedEmail = normalizeEmail(studentEmail);
      let student = await storage.getStudentBySchoolEmail(schoolId, normalizedEmail);

      if (student) {
        // Update device if changed
        if (student.deviceId !== deviceData.deviceId) {
          console.log('[extension/register] Student switched devices');
          student = await storage.updateStudent(student.id, { deviceId: deviceData.deviceId }) || student;
        }
      } else {
        // Create new student
        const studentData = insertStudentSchema.parse({
          deviceId: deviceData.deviceId,
          studentName,
          studentEmail: normalizedEmail,
          gradeLevel: null,
          schoolId,
          studentStatus: 'active',
        });

        try {
          student = await storage.createStudent(studentData);
          console.log('[extension/register] Created new student:', normalizedEmail);
        } catch (createError: any) {
          // Handle race condition
          if (createError?.code === '23505' || createError?.message?.includes('unique')) {
            student = await storage.getStudentBySchoolEmail(schoolId, normalizedEmail);
            if (!student) {
              throw new Error('Failed to retrieve student after concurrent creation');
            }
            if (student.deviceId !== deviceData.deviceId) {
              student = await storage.updateStudent(student.id, { deviceId: deviceData.deviceId }) || student;
            }
          } else {
            throw createError;
          }
        }
      }

      // Set active student for device
      await storage.setActiveStudentForDevice(deviceData.deviceId, student.id);

      // Generate JWT token for subsequent requests
      const studentToken = createStudentToken({
        studentId: student.id,
        deviceId: deviceData.deviceId,
        schoolId: schoolId,
        studentEmail: normalizedEmail,
      });

      console.log('[extension/register] Success - generated token for:', normalizedEmail);

      // Notify teachers
      broadcastToTeachers(schoolId, {
        type: 'student-registered',
        data: { device, student },
      });

      res.json({ success: true, device, student, studentToken });
    } catch (error) {
      console.error("[extension/register] Error:", error);
      if (isLicenseLimitError(error)) {
        return res.status(409).json(buildLicenseLimitResponse(error));
      }
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
    }
  });

  // PUBLIC: Extension settings endpoint - allows authenticated student devices to get school tracking settings
  // This is separate from /api/settings which requires admin auth
  app.get("/api/extension/settings", apiLimiter, requireDeviceAuth, async (req, res) => {
    try {
      const schoolId = res.locals.schoolId as string;

      if (!schoolId) {
        return res.status(400).json({ error: "School context required" });
      }

      // Verify school is active
      const school = await storage.getSchool(schoolId);
      if (!school || !isSchoolLicenseActive(school)) {
        return res.status(403).json({ error: "School inactive" });
      }

      // Get school settings
      const settings = await storage.ensureSettingsForSchool(schoolId);

      // Return only the settings relevant to extensions (tracking hours)
      res.json({
        enableTrackingHours: settings?.enableTrackingHours ?? false,
        trackingStartTime: settings?.trackingStartTime ?? null,
        trackingEndTime: settings?.trackingEndTime ?? null,
        trackingDays: settings?.trackingDays ?? null,
        schoolTimezone: settings?.schoolTimezone ?? null,
        afterHoursMode: settings?.afterHoursMode ?? 'off',
        maxTabsPerStudent: settings?.maxTabsPerStudent ?? null,
      });
    } catch (error) {
      console.error("[extension/settings] Error:", error);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  // Student auto-registration with email (from extension using Chrome Identity API)
  // NOTE: This endpoint requires teacher auth - use /api/extension/register for public access
  app.post("/api/register-student", apiLimiter, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const { deviceId, deviceName, studentEmail, studentName } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      // Validate required fields
      if (!studentEmail || !studentName) {
        return res.status(400).json({ error: "studentEmail and studentName are required" });
      }
      
      // 🔑 DOMAIN-BASED SCHOOL ROUTING: Determine schoolId from email domain
      const schoolInfo = await getSchoolFromEmail(storage, studentEmail);
      if (!schoolInfo) {
        const domain = studentEmail.split('@')[1];
        console.error('[register-student] No school found for provided domain');
        return res.status(404).json({ 
          error: `No school configured for domain: ${domain}`,
          details: 'Please contact your administrator to set up your school in ClassPilot.'
        });
      }
      
      const { schoolId, schoolName } = schoolInfo;
      if (!assertSameSchool(sessionSchoolId, schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      console.log('[register-student] Student routing resolved');
      
      // Register or update device
      const deviceData = insertDeviceSchema.parse({
        deviceId,
        deviceName: deviceName || null,
        classId: schoolId, // Use schoolId as classId for backward compatibility
        schoolId,
      });
      
      let device = await storage.getDevice(deviceData.deviceId);
      if (!device) {
        device = await storage.registerDevice(deviceData);
      }
      
      // Check if student with this email already exists in THIS school (multi-tenant safe)
      const normalizedEmail = normalizeEmail(studentEmail);
      let student = await storage.getStudentBySchoolEmail(schoolId, normalizedEmail);
      
      if (student) {
        // Student exists! Check if they switched devices
        if (student.deviceId !== deviceData.deviceId) {
          console.log('Student switched devices');
          // Update student's device to the new one
          student = await storage.updateStudent(student.id, { deviceId: deviceData.deviceId }) || student;
        } else {
          console.log('Student already registered on this device');
        }
      } else {
        // Create new student (first time seeing this email in this school)
        const studentData = insertStudentSchema.parse({
          deviceId: deviceData.deviceId,
          studentName,
          studentEmail: normalizedEmail,
          gradeLevel: null, // Teacher can assign grade later
          schoolId, // 🔑 Critical: Associate student with correct school
          studentStatus: 'active',
        });

        try {
          student = await storage.createStudent(studentData);
          console.log('New student auto-registered');
        } catch (createError: any) {
          // Handle race condition: another request created the student concurrently
          if (createError?.code === '23505' || createError?.message?.includes('unique')) {
            console.log('Student created concurrently, fetching existing record');
            student = await storage.getStudentBySchoolEmail(schoolId, normalizedEmail);
            if (!student) {
              throw new Error('Failed to retrieve student after concurrent creation');
            }
            // Update device if needed
            if (student.deviceId !== deviceData.deviceId) {
              student = await storage.updateStudent(student.id, { deviceId: deviceData.deviceId }) || student;
            }
          } else {
            throw createError;
          }
        }
      }
      
      // Set this student as the active student for this device
      await storage.setActiveStudentForDevice(deviceData.deviceId, student.id);
      console.log('Set active student for device');
      
      // ✅ JWT AUTHENTICATION: Generate studentToken for industry-standard authentication
      const studentToken = createStudentToken({
        studentId: student.id,
        deviceId: deviceData.deviceId,
        schoolId: schoolId,
        studentEmail: normalizedEmail,
      });
      
      console.log('✅ Generated studentToken');
      
      // Notify teachers in THIS school only
      broadcastToTeachers(schoolId, {
        type: 'student-registered',
        data: { device, student },
      });

      res.json({ success: true, device, student, studentToken }); // 🔑 Return JWT token
    } catch (error) {
      console.error("Student registration error:", error);
      if (isLicenseLimitError(error)) {
        return res.status(409).json(buildLicenseLimitResponse(error));
      }
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
    }
  });

  // Device heartbeat endpoint (from extension) - JWT-authenticated, no staff session required
  app.post("/api/device/heartbeat", requireDeviceAuth, requireActiveSchoolDeviceMiddleware, deviceRateLimit, async (req, res) => {
    try {
      const authSchoolId = res.locals.schoolId as string | undefined;
      const authStudentId = res.locals.studentId as string | undefined;
      const authDeviceId = res.locals.deviceId as string | undefined;

      if (!authSchoolId || !authStudentId || !authDeviceId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Check Super Admin configured school-level tracking window
      const school = res.locals.school as School | undefined;
      if (school && !isSchoolTrackingAllowed(school)) {
        return res.sendStatus(204);
      }

      // Check school admin configured tracking hours
      const settings = await storage.ensureSettingsForSchool(authSchoolId);
      if (!isTrackingAllowedNow(settings)) {
        return res.sendStatus(204);
      }

      const now = Date.now();
      const deviceKey = authDeviceId;

      const lastAcceptedAt = deviceKey ? heartbeatLastAcceptedAt.get(deviceKey) : undefined;
      if (deviceKey && lastAcceptedAt && now - lastAcceptedAt < DEVICE_HEARTBEAT_MIN_INTERVAL_MS) {
        return res.sendStatus(204);
      }

      const allowTierFullPayload = assertTierAtLeast(school, "pro");
      const fullPayloadRequested = isFullHeartbeatPayload(req);
      const lastFullPayloadAt = deviceKey ? heartbeatLastFullPayloadAt.get(deviceKey) : undefined;
      const allowFullPayload = allowTierFullPayload && (!fullPayloadRequested
        || !lastFullPayloadAt
        || now - lastFullPayloadAt >= HEARTBEAT_FULL_PAYLOAD_MIN_MS);
      const dropHeavyPayload = fullPayloadRequested && !allowFullPayload;

      const payloadForValidation = {
        ...(dropHeavyPayload ? stripHeavyHeartbeatFields(req.body) : req.body ?? {}),
        studentId: authStudentId,
        deviceId: authDeviceId,
        schoolId: authSchoolId,
      };

      const result = heartbeatRequestSchema.safeParse(payloadForValidation);

      if (!result.success) {
        console.warn("Invalid heartbeat data received");
        return res.sendStatus(204);
      }

      const fullData = result.data;
      const { allOpenTabs, ...data } = fullData;

      data.studentId = authStudentId;
      data.deviceId = authDeviceId;
      data.schoolId = authSchoolId;
      if (res.locals.studentEmail) {
        data.studentEmail = res.locals.studentEmail;
      }

      if (deviceKey) {
        heartbeatLastAcceptedAt.set(deviceKey, now);
      }
      if (fullPayloadRequested && allowFullPayload && deviceKey) {
        heartbeatLastFullPayloadAt.set(deviceKey, now);
      }

      if (!isTrackingAllowedNow(settings)) {
        return res.sendStatus(204);
      }

      const lastPersistedAt = deviceKey ? heartbeatLastPersistedAt.get(deviceKey) : undefined;
      const shouldPersist =
        !deviceKey || !lastPersistedAt || now - lastPersistedAt >= HEARTBEAT_PERSIST_MIN_MS;

      if (!shouldPersist) {
        return res.sendStatus(204);
      }

      if (data.studentEmail && data.schoolId) {
        try {
          await ensureStudentDeviceAssociation(storage, data.deviceId, data.studentEmail, data.schoolId);
        } catch (error) {
          console.error("[heartbeat] Email-first provisioning error:", error);
        }
      }

      if (deviceKey) {
        heartbeatLastPersistedAt.set(deviceKey, now);
      }

      const persisted = enqueueHeartbeatPersist(async () => {
        await storage.addHeartbeat(data, allOpenTabs);
        // Store lastSeenAt in Redis for multi-instance consistency
        await setDeviceLastSeen(data.deviceId, Date.now());
        if (data.schoolId) {
          broadcastToTeachers(data.schoolId, {
            type: "student-update",
            deviceId: data.deviceId,
          });
        }
      });

      if (!persisted && deviceKey) {
        heartbeatLastPersistedAt.delete(deviceKey);
      }

      if (dropHeavyPayload) {
        return res.sendStatus(204);
      }

      return res.status(200).json({ ok: true, persisted });
    } catch (error) {
      console.error("Heartbeat uncaught error:", error);
      return res.sendStatus(204);
    }
  });

  // Screenshot upload endpoint (from extension) - JWT-authenticated
  app.post("/api/device/screenshot", requireDeviceAuth, requireActiveSchoolDeviceMiddleware, async (req, res) => {
    try {
      const authDeviceId = res.locals.deviceId as string | undefined;
      if (!authDeviceId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { screenshot, timestamp, tabTitle, tabUrl, tabFavicon } = req.body;
      if (!screenshot || typeof screenshot !== "string") {
        return res.status(400).json({ error: "Invalid screenshot data" });
      }

      // Validate screenshot size (base64 encoded, ~200KB max)
      if (screenshot.length > SCREENSHOT_MAX_SIZE_BYTES * 1.4) { // Base64 is ~1.33x larger
        return res.status(400).json({ error: "Screenshot too large" });
      }

      // Validate it's a data URL
      if (!screenshot.startsWith("data:image/")) {
        return res.status(400).json({ error: "Invalid screenshot format" });
      }

      // Store screenshot with tab metadata
      const screenshotPayload: ScreenshotData = {
        screenshot,
        timestamp: timestamp || Date.now(),
        tabTitle: typeof tabTitle === "string" ? tabTitle : undefined,
        tabUrl: typeof tabUrl === "string" ? tabUrl : undefined,
        tabFavicon: typeof tabFavicon === "string" ? tabFavicon : undefined,
      };

      // Try Redis first (for multi-instance deployments), fallback to in-memory
      const storedInRedis = await setScreenshot(authDeviceId, screenshotPayload);
      if (!storedInRedis) {
        // Fallback to local in-memory storage
        deviceScreenshotsLocal.set(authDeviceId, screenshotPayload);
      }

      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error("Screenshot upload error:", error);
      return res.status(500).json({ error: "Failed to upload screenshot" });
    }
  });

  // Screenshot retrieval endpoint (for teacher dashboard) - requires auth
  app.get("/api/device/screenshot/:deviceId", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      // Verify the device belongs to the same school
      const device = await storage.getDevice(deviceId);
      if (!device || device.schoolId !== sessionSchoolId) {
        return res.status(404).json({ error: "Device not found" });
      }

      // Try Redis first (for multi-instance deployments), fallback to in-memory
      let screenshotData = await getScreenshot(deviceId);
      if (!screenshotData) {
        // Fallback to local in-memory storage
        screenshotData = deviceScreenshotsLocal.get(deviceId) ?? null;
      }

      if (!screenshotData) {
        return res.status(404).json({ error: "No screenshot available" });
      }

      // Check if screenshot is expired (Redis handles TTL automatically, but check for in-memory)
      if (Date.now() - screenshotData.timestamp > SCREENSHOT_TTL_MS) {
        deviceScreenshotsLocal.delete(deviceId);
        return res.status(404).json({ error: "Screenshot expired" });
      }

      return res.status(200).json({
        screenshot: screenshotData.screenshot,
        timestamp: screenshotData.timestamp,
        tabTitle: screenshotData.tabTitle,
        tabUrl: screenshotData.tabUrl,
        tabFavicon: screenshotData.tabFavicon,
      });
    } catch (error) {
      console.error("Screenshot retrieval error:", error);
      return res.status(500).json({ error: "Failed to retrieve screenshot" });
    }
  });

  // Heartbeat endpoint (from extension) - bulletproof, never returns 500
  app.post("/api/heartbeat", heartbeatLimiter, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      // Validate input with heartbeatRequestSchema (includes allOpenTabs)
      const result = heartbeatRequestSchema.safeParse(req.body);
      
      if (!result.success) {
        console.warn('Invalid heartbeat data received');
        // Return 204 even on validation failure to prevent extension from retrying
        return res.sendStatus(204);
      }
      
      const fullData = result.data;
      // Extract allOpenTabs (in-memory only) and database fields separately
      const { allOpenTabs, studentToken, ...data } = fullData;
      
      // ✅ JWT AUTHENTICATION: Verify studentToken if provided (INDUSTRY STANDARD)
      if (studentToken) {
        try {
          const payload = verifyStudentToken(studentToken);
          
          // Override heartbeat data with authenticated values from JWT
          // This prevents tampering with studentId, deviceId, or schoolId
          data.studentId = payload.studentId;
          data.deviceId = payload.deviceId;
          data.schoolId = payload.schoolId;
          if (payload.studentEmail) {
            data.studentEmail = payload.studentEmail;
          }
        } catch (error) {
          if (error instanceof TokenExpiredError) {
            console.warn('❌ Token expired - student needs to re-register');
            // Return 401 to trigger extension re-registration
            return res.status(401).json({ error: 'Token expired, please re-register' });
          } else if (error instanceof InvalidTokenError) {
            console.warn('❌ Invalid token - rejecting heartbeat');
            return res.status(403).json({ error: 'Invalid token' });
          }
          throw error; // Unexpected error
        }
      } else {
        // Legacy mode (no JWT) - determine schoolId from email domain
        
        if (data.studentEmail) {
          const schoolInfo = await getSchoolFromEmail(storage, data.studentEmail);
          if (!schoolInfo) {
            const domain = data.studentEmail.split('@')[1];
            // Return 404 to indicate school not configured
            return res.status(404).json({ 
              error: `No school configured for domain: ${domain}`,
              details: 'Please contact your administrator to set up your school in ClassPilot.'
            });
          }
          
          data.schoolId = schoolInfo.schoolId;
        } else {
          console.error('[heartbeat] Legacy heartbeat missing email');
          return res.status(400).json({ error: 'Student email is required' });
        }
      }

      if (data.schoolId) {
        const school = await storage.getSchool(data.schoolId);
        if (!school) {
          return res.status(404).json({ error: "School not found" });
        }
        if (!isSchoolLicenseActive(school)) {
          return res.status(402).json({
            error: "School license inactive",
            planStatus: school.planStatus,
            schoolActive: false,
          });
        }
        // Check Super Admin configured school-level tracking window first
        if (!isSchoolTrackingAllowed(school)) {
          // Outside school tracking hours - return 204 to prevent retries but don't store
          return res.sendStatus(204);
        }
      }

      // Check if school admin tracking hours are enforced (timezone-aware)
      // This is a secondary check for more granular school admin control
      const schoolId = data.schoolId ?? sessionSchoolId;
      const settings = await storage.ensureSettingsForSchool(schoolId);
      if (!isTrackingAllowedNow(settings)) {
        // Return 204 to prevent extension from retrying, but don't store heartbeat
        return res.sendStatus(204);
      }
      
      const deviceKey = data.deviceId;
      const now = Date.now();
      const lastPersistedAt = deviceKey ? heartbeatLastPersistedAt.get(deviceKey) : undefined;
      const shouldPersist =
        !deviceKey || !lastPersistedAt || now - lastPersistedAt >= HEARTBEAT_PERSIST_MIN_MS;

      if (!shouldPersist) {
        return res.status(200).json({ ok: true, persisted: false });
      }

      // EMAIL-FIRST AUTO-PROVISIONING: If heartbeat has email+schoolId, ensure student exists
      if (data.studentEmail && data.schoolId) {
        try {
          await ensureStudentDeviceAssociation(storage, data.deviceId, data.studentEmail, data.schoolId);
        } catch (error) {
          console.error('[heartbeat] Email-first provisioning error:', error);
          // Continue to store heartbeat even if provisioning fails
        }
      }

      if (deviceKey) {
        heartbeatLastPersistedAt.set(deviceKey, now);
      }

      if (!assertSameSchool(sessionSchoolId, data.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const persisted = enqueueHeartbeatPersist(async () => {
        await storage.addHeartbeat(data, allOpenTabs);
        // Store lastSeenAt in Redis for multi-instance consistency
        await setDeviceLastSeen(data.deviceId, Date.now());
        // Notify teachers of update (non-blocking)
        if (data.schoolId) {
          broadcastToTeachers(data.schoolId, {
            type: 'student-update',
            deviceId: data.deviceId,
          });
        }
      });

      if (!persisted && deviceKey) {
        heartbeatLastPersistedAt.delete(deviceKey);
      }

      return res.status(200).json({ ok: true, persisted });
    } catch (error) {
      // Final safety net - never throw
      console.error("Heartbeat uncaught error:", error);
      return res.sendStatus(204);
    }
  });

  // Device event logging endpoint (from extension) - JWT-authenticated, no staff session required
  app.post("/api/device/event", apiLimiter, requireDeviceAuth, requireActiveSchoolDeviceMiddleware, async (req, res) => {
    try {
      const authSchoolId = res.locals.schoolId as string | undefined;
      const authStudentId = res.locals.studentId as string | undefined;
      const authDeviceId = res.locals.deviceId as string | undefined;

      if (!authSchoolId || !authDeviceId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Check Super Admin configured school-level tracking window
      const school = res.locals.school as School | undefined;
      if (school && !isSchoolTrackingAllowed(school)) {
        return res.sendStatus(204);
      }

      // Check school admin configured tracking hours
      const settings = await storage.ensureSettingsForSchool(authSchoolId);
      if (!isTrackingAllowedNow(settings)) {
        return res.sendStatus(204);
      }

      const payloadForValidation = {
        ...req.body,
        deviceId: authDeviceId,
        studentId: authStudentId,
      };

      const result = insertEventSchema.safeParse(payloadForValidation);

      if (!result.success) {
        console.warn("Invalid event data:", result.error.format(), req.body);
        return res.sendStatus(204);
      }

      const data = result.data;
      data.deviceId = authDeviceId;
      if (authStudentId) {
        data.studentId = authStudentId;
      }

      const device = await storage.getDevice(data.deviceId);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      if (device.schoolId !== authSchoolId) {
        return res.status(404).json({ error: "Device not found" });
      }

      if (data.studentId) {
        const student = await storage.getStudent(data.studentId);
        if (!student || student.schoolId !== authSchoolId) {
          return res.status(404).json({ error: "Student not found" });
        }
      }

      storage.addEvent(data)
        .then((event) => {
          if (authSchoolId && ['consent_granted', 'consent_revoked', 'blocked_domain', 'navigation', 'url_change'].includes(data.eventType)) {
            broadcastToTeachers(authSchoolId, {
              type: "student-event",
              data: event,
            });
          }
        })
        .catch((error) => {
          console.error("Event storage error:", error);
        });

      return res.sendStatus(204);
    } catch (error) {
      console.error("Event uncaught error:", error, req.body);
      return res.sendStatus(204);
    }
  });

  // Event logging endpoint (from extension) - bulletproof, never returns 500
  app.post("/api/event", apiLimiter, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      // Validate input with safe parse
      const result = insertEventSchema.safeParse(req.body);
      
      if (!result.success) {
        console.warn('Invalid event data:', result.error.format(), req.body);
        // Return 204 to prevent extension from retrying
        return res.sendStatus(204);
      }
      
      const data = result.data;

      const device = await storage.getDevice(data.deviceId);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      const school = await storage.getSchool(device.schoolId);
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }
      if (!isSchoolLicenseActive(school)) {
        return res.status(402).json({
          error: "School license inactive",
          planStatus: school.planStatus,
          schoolActive: false,
        });
      }
      if (!assertSameSchool(sessionSchoolId, device.schoolId)) {
        return res.status(404).json({ error: "Device not found" });
      }

      if (data.studentId) {
        const student = await storage.getStudent(data.studentId);
        if (!student) {
          return res.status(404).json({ error: "Student not found" });
        }
        if (!assertSameSchool(sessionSchoolId, student.schoolId)) {
          return res.status(404).json({ error: "Student not found" });
        }
      }
      
      // Store event asynchronously - don't block the response
      storage.addEvent(data)
        .then((event) => {
          // Notify teachers of important events (non-blocking)
          if (['consent_granted', 'consent_revoked', 'blocked_domain', 'navigation', 'url_change'].includes(data.eventType)) {
            broadcastToTeachers(sessionSchoolId, {
              type: 'student-event',
              data: event,
            });
          }
        })
        .catch((error) => {
          // Log but don't fail - we already responded to client
          console.error("Event storage error:", error);
        });

      // Always return success immediately
      return res.sendStatus(204);
    } catch (error) {
      // Final safety net - never throw
      console.error("Event uncaught error:", error, req.body);
      return res.sendStatus(204);
    }
  });

  // Get all student statuses (for dashboard)
  app.get("/api/students", checkIPAllowlist, requireAuth, requireActiveSchoolMiddleware, requireSchoolContext, requireTeacherRole, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const sessionRole = req.session.role === "admin" ? "school_admin" : req.session.role;
      
      const allStatuses = await storage.getStudentStatusesBySchool(sessionSchoolId);
      const allStudents = await storage.getStudentsBySchool(sessionSchoolId);
      
      // Admins see all students from their school; teachers see only students in their active session
      // School admins who also teach can start a session to filter to their class
      let filteredStatuses: typeof allStatuses;
      
      // Check if user has an active teaching session (applies to both teachers and school_admins)
      const activeSession = await storage.getActiveSessionByTeacher(userId);
      
      if (activeSession?.groupId) {
        const group = await storage.getGroup(activeSession.groupId);
        if (!group) {
          return res.status(404).json({ error: "Group not found" });
        }
        if (!assertSameSchool(sessionSchoolId, group.schoolId)) {
          return res.status(404).json({ error: "Group not found" });
        }
        // User has an active session - show only students in that session (teacher mode)
        console.log('User has active session for group:', activeSession.groupId, '(role:', sessionRole, ')');
        
        // Get all students assigned to this session's group
        const rosterStudentIds = await storage.getGroupStudents(activeSession.groupId);
        console.log('  - Roster has', rosterStudentIds.length, 'students assigned');
        
        // Filter active statuses to only include students in this session's roster
        filteredStatuses = allStatuses.filter(s => rosterStudentIds.includes(s.studentId));
        console.log('  - Found', filteredStatuses.length, 'active students in session roster');
        
        // Find students in roster but not in active statuses (offline students)
        const activeStudentIds = new Set(filteredStatuses.map(s => s.studentId));
        const offlineStudentIds = rosterStudentIds.filter(id => !activeStudentIds.has(id));
        
        if (offlineStudentIds.length > 0) {
          console.log('  - Creating offline placeholders for', offlineStudentIds.length, 'students');
          
          // Create offline placeholders for roster students not yet connected
          const offlinePlaceholders = await Promise.all(
            offlineStudentIds.map(async (studentId) => {
              const student = await storage.getStudent(studentId);
              if (!student || !assertSameSchool(sessionSchoolId, student.schoolId)) return null;
              
              const device = student.deviceId ? await storage.getDevice(student.deviceId) : null;
              
              return {
                studentId: student.id,
                deviceId: student.deviceId,
                deviceName: device?.deviceName ?? undefined,
                studentName: student.studentName,
                classId: device?.classId || '',
                gradeLevel: student.gradeLevel ?? undefined,
                activeTabTitle: '',
                activeTabUrl: '',
                favicon: undefined,
                lastSeenAt: 0,
                isSharing: false,
                screenLocked: false,
                flightPathActive: false,
                activeFlightPathName: undefined,
                screenLockedSetAt: undefined,
                cameraActive: false,
                currentUrlDuration: undefined,
                viewMode: 'url' as const,
                status: 'offline' as const,
              };
            })
          );
          
          // Filter out nulls and add to filtered statuses
          const validPlaceholders = offlinePlaceholders.filter((p): p is NonNullable<typeof p> => p !== null);
          filteredStatuses = [...filteredStatuses, ...validPlaceholders];
          console.log('  - Total students (active + offline):', filteredStatuses.length);
        }
      } else if (sessionRole === 'school_admin' || sessionRole === 'super_admin') {
        // Admin/school_admin without active session - show all students in school
        filteredStatuses = allStatuses;
        console.log('Dashboard requested students (admin mode) - found:', filteredStatuses.length, 'students in school');
      } else {
        // Teacher without active session - show empty (they need to start a session)
        filteredStatuses = [];
        console.log('Teacher has no active session - showing empty state');
      }
      
      filteredStatuses.forEach(s => {
        console.log(`  - ${s.studentName} (grade: ${s.gradeLevel}, status: ${s.status}, screenLocked: ${s.screenLocked})`);
      });

      // Overlay Redis flight path status for multi-instance consistency
      if (isRedisEnabled()) {
        for (const status of filteredStatuses) {
          if (status.deviceId) {
            const redisFlightPath = await getFlightPathStatus(status.deviceId);
            if (redisFlightPath) {
              status.flightPathActive = redisFlightPath.active;
              status.activeFlightPathName = redisFlightPath.flightPathName;
            }
          }
        }
      }

      res.json(filteredStatuses);
    } catch (error) {
      console.error("Get students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get aggregated student statuses (one per student, grouped by email)
  app.get("/api/students-aggregated", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const sessionRole = req.session.role === "admin" ? "school_admin" : req.session.role;
      const allAggregated = await storage.getStudentStatusesAggregatedBySchool(sessionSchoolId);
      const allStudents = await storage.getStudentsBySchool(sessionSchoolId);
      
      // Check if user has an active teaching session (applies to both teachers and school_admins)
      const activeSession = await storage.getActiveSessionByTeacher(userId);
      
      let filteredStatuses: typeof allAggregated;
      
      if (activeSession?.groupId) {
        const group = await storage.getGroup(activeSession.groupId);
        if (!group) {
          return res.status(404).json({ error: "Group not found" });
        }
        if (!assertSameSchool(sessionSchoolId, group.schoolId)) {
          return res.status(404).json({ error: "Group not found" });
        }
        // User has an active session - show only students in that session (teacher mode)
        console.log('User has active session for group:', activeSession.groupId, '(role:', sessionRole, ')');
        
        // Get all students assigned to this session's group
        const rosterStudentIds = await storage.getGroupStudents(activeSession.groupId);
        console.log('  - Roster has', rosterStudentIds.length, 'students assigned');
        
        // Filter active statuses to only include students in this session's roster
        filteredStatuses = allAggregated.filter(s => rosterStudentIds.includes(s.studentId));
        console.log('  - Found', filteredStatuses.length, 'active students in session roster');
        
        // Find students in roster but not in active statuses (offline students)
        const activeStudentIds = new Set(filteredStatuses.map(s => s.studentId));
        const offlineStudentIds = rosterStudentIds.filter(id => !activeStudentIds.has(id));
        
        if (offlineStudentIds.length > 0) {
          console.log('  - Creating offline placeholders for', offlineStudentIds.length, 'students');
          
          // Create offline placeholders for roster students not yet connected
          const offlinePlaceholders = await Promise.all(
            offlineStudentIds.map(async (studentId) => {
              const student = await storage.getStudent(studentId);
              if (!student || !assertSameSchool(sessionSchoolId, student.schoolId)) return null;
              
              const device = student.deviceId ? await storage.getDevice(student.deviceId) : null;
              
              return {
                studentId: student.id,
                studentEmail: student.studentEmail || undefined,
                studentName: student.studentName,
                classId: device?.classId || '',
                gradeLevel: student.gradeLevel ?? undefined,
                
                // Multi-device info
                deviceCount: 0,
                devices: [],
                
                // Aggregated status
                status: 'offline' as const,
                lastSeenAt: 0,
                
                // Primary device data (placeholder)
                primaryDeviceId: student.deviceId,
                activeTabTitle: '',
                activeTabUrl: '',
                favicon: undefined,
                isSharing: false,
                screenLocked: false,
                flightPathActive: false,
                activeFlightPathName: undefined,
                cameraActive: false,
                currentUrlDuration: undefined,
                viewMode: 'url' as const,
              };
            })
          );
          
          // Filter out nulls and add to filtered statuses
          const validPlaceholders = offlinePlaceholders.filter((p): p is NonNullable<typeof p> => p !== null);
          filteredStatuses = [...filteredStatuses, ...validPlaceholders];
          console.log('  - Total students (active + offline):', filteredStatuses.length);
        }
      } else if (sessionRole === 'school_admin' || sessionRole === 'super_admin') {
        // Admin/school_admin without active session - show all students
        filteredStatuses = allAggregated;
        console.log('Dashboard requested aggregated students (admin mode) - found:', filteredStatuses.length, 'students');
      } else {
        // Teacher without active session - show empty (they need to start a session)
        filteredStatuses = [];
        console.log('Teacher has no active session - showing empty dashboard');
      }

      // Overlay Redis data for multi-instance consistency
      if (isRedisEnabled()) {
        for (const status of filteredStatuses) {
          if (status.primaryDeviceId) {
            // Overlay lastSeenAt from Redis (ensures all instances see same timestamp)
            const redisLastSeen = await getDeviceLastSeen(status.primaryDeviceId);
            if (redisLastSeen && redisLastSeen > status.lastSeenAt) {
              status.lastSeenAt = redisLastSeen;
              // Recalculate status based on Redis lastSeenAt
              const timeSinceLastSeen = Date.now() - redisLastSeen;
              if (timeSinceLastSeen < 90000) {
                status.status = 'online';
              } else if (timeSinceLastSeen < 180000) {
                status.status = 'idle';
              } else {
                status.status = 'offline';
              }
            }

            // Overlay flight path status from Redis
            const redisFlightPath = await getFlightPathStatus(status.primaryDeviceId);
            if (redisFlightPath) {
              status.flightPathActive = redisFlightPath.active;
              status.activeFlightPathName = redisFlightPath.flightPathName;
            }
          }
        }
      }

      res.json(filteredStatuses);
    } catch (error) {
      console.error("Error fetching aggregated students:", error);
      res.status(500).json({ error: "Failed to fetch aggregated students" });
    }
  });

  // Get students assigned to a specific device (for extension popup)
  app.get("/api/device/:deviceId/students", apiLimiter, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const device = await storage.getDevice(deviceId);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, device.schoolId)) {
        return res.status(404).json({ error: "Device not found" });
      }
      const students = await storage.getStudentsByDevice(sessionSchoolId, deviceId);
      const activeStudent = await storage.getActiveStudentForDevice(deviceId);
      
      res.json({ 
        students,
        activeStudentId: activeStudent?.id || null
      });
    } catch (error) {
      console.error("Get device students error:", error);
      res.status(500).json({ error: "Failed to fetch students" });
    }
  });

  // Set active student for a device (from extension)
  app.post("/api/device/:deviceId/active-student", apiLimiter, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const { studentId } = req.body;

      const device = await storage.getDevice(deviceId);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, device.schoolId)) {
        return res.status(404).json({ error: "Device not found" });
      }
      
      // Verify student exists and belongs to this device
      if (studentId) {
        const student = await storage.getStudent(studentId);
        if (!student || student.deviceId !== deviceId) {
          return res.status(400).json({ error: "Invalid student for this device" });
        }
        if (!assertSameSchool(sessionSchoolId, student.schoolId)) {
          return res.status(404).json({ error: "Student not found" });
        }
      }
      
      await storage.setActiveStudentForDevice(deviceId, studentId || null);
      
      // Log student switch event
      if (studentId) {
        await storage.addEvent({
          deviceId,
          studentId,
          eventType: 'student_switched',
          metadata: { timestamp: new Date().toISOString() },
        });
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Set active student error:", error);
      res.status(500).json({ error: "Failed to set active student" });
    }
  });

  // Get all persisted students from database (for roster management)
  app.get("/api/roster/students", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      // Enforce tenant isolation: only show students from user's school
      const students = await storage.getStudentsBySchool(sessionSchoolId);
      res.json(students);
    } catch (error) {
      console.error("Get roster students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all devices from database (for roster management)
  app.get("/api/roster/devices", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      // Enforce tenant isolation: only show devices that have students from user's school
      const allDevices = await storage.getDevicesBySchool(sessionSchoolId);
      const allStudents = await storage.getStudentsBySchool(sessionSchoolId);
      const schoolStudentDeviceIds = new Set(allStudents.map(s => s.deviceId));
      
      const devices = allDevices.filter(d => schoolStudentDeviceIds.has(d.deviceId));
      res.json(devices);
    } catch (error) {
      console.error("Get roster devices error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Create student manually (for roster management)
  app.post("/api/roster/student", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      const { studentName, deviceId, gradeLevel } = req.body;
      
      if (!studentName || typeof studentName !== 'string') {
        return res.status(400).json({ error: "Student name is required" });
      }
      
      if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: "Device ID is required" });
      }
      
      // Verify device exists
      const device = await storage.getDevice(deviceId);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      if (!assertSameSchool(sessionSchoolId, device.schoolId)) {
        return res.status(404).json({ error: "Device not found" });
      }
      
      // Enforce tenant isolation: create student with user's schoolId
      const studentData = insertStudentSchema.parse({
        deviceId,
        studentName,
        gradeLevel: normalizeGradeLevel(gradeLevel),
        schoolId: sessionSchoolId, // Enforce tenant isolation
      });
      
      const student = await storage.createStudent(studentData);
      
      // Broadcast update to teachers
      broadcastToTeachers(sessionSchoolId, {
        type: 'student-update',
        deviceId: student.deviceId,
      });
      
      res.json({ success: true, student });
    } catch (error) {
      console.error("Create student error:", error);
      if (isLicenseLimitError(error)) {
        return res.status(409).json(buildLicenseLimitResponse(error));
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Bulk create students
  app.post("/api/roster/bulk", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { students: studentsData } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      if (!Array.isArray(studentsData) || studentsData.length === 0) {
        return res.status(400).json({ error: "Students array is required" });
      }
      
      const createdStudents = [];
      const errors = [];
      
      for (const studentInput of studentsData) {
        try {
          const device = await storage.getDevice(studentInput.deviceId);
          if (!device) {
            throw new Error("Device not found");
          }
          if (!assertSameSchool(sessionSchoolId, device.schoolId)) {
            throw new Error("Device not found");
          }

          const studentData = insertStudentSchema.parse({
            deviceId: studentInput.deviceId,
            studentName: studentInput.studentName,
            gradeLevel: normalizeGradeLevel(studentInput.gradeLevel),
            schoolId: sessionSchoolId,
          });
          
          const student = await storage.createStudent(studentData);
          createdStudents.push(student);
        } catch (error) {
          if (isLicenseLimitError(error)) {
            if (createdStudents.length > 0) {
              broadcastToTeachers(sessionSchoolId, {
                type: 'student-update',
                deviceId: 'bulk-update',
              });
            }
            return res.status(409).json({
              ...buildLicenseLimitResponse(error),
              created: createdStudents.length,
              students: createdStudents,
              errors: errors.length > 0 ? errors : undefined,
            });
          }
          errors.push({
            deviceId: studentInput.deviceId,
            error: error instanceof Error ? error.message : "Failed to create student"
          });
        }
      }
      
      // Broadcast update to teachers
      broadcastToTeachers(sessionSchoolId, {
        type: 'student-update',
        deviceId: 'bulk-update',
      });
      
      res.json({ 
        success: true, 
        created: createdStudents.length, 
        students: createdStudents,
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (error) {
      console.error("Bulk create students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/roster/import-google", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    const { google } = await import("googleapis");
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, user.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const tokens = await storage.getGoogleOAuthTokens(user.id);
      if (!tokens?.refreshToken) {
        return res.status(400).json({ error: "Google Classroom access not connected. Please re-authenticate with Google." });
      }

      const redirectUri = `${getBaseUrl()}/auth/google/callback`;

      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        redirectUri
      );
      oauth2Client.setCredentials({ refresh_token: tokens.refreshToken });
      const classroom = google.classroom({ version: "v1", auth: oauth2Client });

      const coursesResponse = await classroom.courses.list({
        teacherId: "me",
        courseStates: ["ACTIVE"],
      });
      const courses = coursesResponse.data.courses ?? [];

      let coursesImported = 0;
      let membershipsWritten = 0;
      const studentIdsSeen = new Set<string>();

      for (const course of courses) {
        if (!course.id || !course.name) {
          continue;
        }

        await storage.upsertClassroomCourse({
          schoolId: sessionSchoolId,
          courseId: course.id,
          name: course.name,
          section: course.section ?? null,
          room: course.room ?? null,
          descriptionHeading: course.descriptionHeading ?? null,
          ownerId: course.ownerId ?? null,
          lastSyncedAt: new Date(),
        });
        coursesImported += 1;

        const courseStudentEntries: Array<{ studentId: string; googleUserId?: string | null; studentEmailLc?: string | null }> = [];
        let pageToken: string | undefined;

        do {
          const studentsResponse = await classroom.courses.students.list({
            courseId: course.id,
            pageSize: 100,
            pageToken,
          });
          const students = studentsResponse.data.students ?? [];

          for (const student of students) {
            const profile = student.profile;
            const email = profile?.emailAddress;
            if (!email) {
              continue;
            }
            const emailLc = normalizeEmail(email);
            const googleUserId = profile?.id ?? null;

            let rosterStudent = await storage.getStudentBySchoolEmail(sessionSchoolId, emailLc);
            if (!rosterStudent && googleUserId) {
              rosterStudent = await storage.getStudentBySchoolGoogleUserId(sessionSchoolId, googleUserId);
            }

            let savedStudent: Awaited<ReturnType<typeof storage.updateStudent>> | undefined;
            const studentName = profile?.name?.fullName ?? email;

            if (rosterStudent) {
              savedStudent = await storage.updateStudent(rosterStudent.id, {
                studentName: studentName || rosterStudent.studentName,
                studentEmail: email,
                emailLc,
                googleUserId: googleUserId ?? rosterStudent.googleUserId,
              });
            } else {
              try {
                savedStudent = await storage.createStudent({
                  studentName,
                  studentEmail: email,
                  emailLc,
                  schoolId: sessionSchoolId,
                  studentStatus: "active",
                  googleUserId,
                });
              } catch (error) {
                if (isLicenseLimitError(error)) {
                  return res.status(409).json({
                    ...buildLicenseLimitResponse(error),
                    coursesImported,
                    studentsUpserted: studentIdsSeen.size,
                    membershipsWritten,
                  });
                }
                throw error;
              }
            }

            if (savedStudent) {
              if (!studentIdsSeen.has(savedStudent.id)) {
                studentIdsSeen.add(savedStudent.id);
              }
              courseStudentEntries.push({
                studentId: savedStudent.id,
                googleUserId,
                studentEmailLc: emailLc,
              });
            }
          }

          pageToken = studentsResponse.data.nextPageToken ?? undefined;
        } while (pageToken);

        membershipsWritten += await storage.replaceCourseStudents(
          sessionSchoolId,
          course.id,
          courseStudentEntries
        );
      }

      res.json({
        coursesImported,
        studentsUpserted: studentIdsSeen.size,
        membershipsWritten,
      });
    } catch (error) {
      console.error("Google Classroom import error:", error);
      const message = error instanceof Error ? error.message : "Google Classroom import failed";
      res.status(502).json({ error: message });
    }
  });

  // === Google Classroom Routes ===

  // 1. List Courses (Syncs list from Google to DB)
  app.get("/api/classroom/courses", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || !user.schoolId) {
        return res.status(400).json({ error: "User must belong to a school" });
      }
      const schoolId = req.session.schoolId!;

      // Check if user has connected Google
      const tokens = await storage.getGoogleOAuthTokens(user.id);
      if (!tokens) {
        return res.status(403).json({ error: "Google Classroom not connected", code: "NO_TOKENS" });
      }

      // Perform sync
      const courses = await syncCourses(user.id, schoolId);
      res.json({ courses });
    } catch (error: any) {
      console.error("Classroom courses error:", error);
      res.status(500).json({ error: error.message || "Failed to sync courses" });
    }
  });

  // 2. Sync Roster for a specific course
  app.post("/api/classroom/courses/:courseId/sync", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || !user.schoolId) return res.status(401).send();
      const schoolId = req.session.schoolId!;

      const { courseId } = req.params;
      const { gradeLevel } = req.body;

      // Sync the student list from Google (only returns students who accepted invitation)
      const syncedStudents = await syncRoster(user.id, schoolId, courseId, { gradeLevel });

      // Automatically create a ClassPilot group for this course
      const course = await storage.getClassroomCourse(schoolId, courseId);
      let assignedCount = 0;

      if (course) {
        // Check if group exists for this teacher with this name
        const groups = await storage.getGroupsByTeacher(user.id);
        let group = groups.find(g => g.name === course.name);

        if (!group) {
          group = await storage.createGroup({
            teacherId: user.id,
            schoolId,
            name: course.name,
            groupType: "admin_class",
            gradeLevel: gradeLevel || null,
            description: `Imported from Google Classroom: ${course.section || ""}`,
          });
        }

        // Get all students linked to this course (from classroom_course_students table)
        // This includes students who may have been imported via Google Workspace
        const courseStudentIds = await storage.getClassroomCourseStudentIds(schoolId, courseId);

        // Also add any synced students from Google Classroom API
        const allStudentIds = Array.from(new Set([
          ...courseStudentIds,
          ...syncedStudents.map(s => s.studentId)
        ]));

        // Add students to the ClassPilot group
        for (const studentId of allStudentIds) {
          try {
            await storage.assignStudentToGroup(group.id, studentId);
            // Update grade level if provided
            if (gradeLevel) {
              await storage.updateStudent(studentId, { gradeLevel });
            }
            assignedCount++;
          } catch (e) {
            // Continue if assignment already exists
          }
        }
      }

      res.json({ success: true, count: assignedCount, syncedFromGoogle: syncedStudents.length });
    } catch (error: any) {
      console.error("Classroom roster sync error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get classroom courses for admin preview (with teacher info and student counts)
  app.get("/api/admin/classroom/courses-preview", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || !user.schoolId) {
        return res.status(400).json({ error: "User must belong to a school" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, user.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const schoolId = sessionSchoolId;

      // Get all classroom courses for this school
      const courses = await storage.getClassroomCoursesForSchool(schoolId);
      
      // Get all teachers in the school to match by googleId
      const schoolUsers = await storage.getUsersBySchool(schoolId);
      const teachersByGoogleId = new Map<string, { id: string; displayName: string | null; email: string }>();
      for (const u of schoolUsers) {
        if (u.googleId && (u.role === "teacher" || u.role === "school_admin")) {
          teachersByGoogleId.set(u.googleId, { id: u.id, displayName: u.displayName, email: u.email });
        }
      }
      
      // Get existing ClassPilot classes to check for duplicates
      const allGroups = await storage.getGroupsBySchool(schoolId);
      const existingClassNames = new Set(allGroups.map(g => g.name.toLowerCase()));

      // Build preview with student counts and teacher info
      const coursesPreview = await Promise.all(courses.map(async (course) => {
        const studentCount = await storage.getClassroomCourseStudentCount(schoolId, course.courseId);
        const teacher = course.ownerId ? teachersByGoogleId.get(course.ownerId) : undefined;
        const alreadyExists = existingClassNames.has(course.name.toLowerCase());
        
        return {
          courseId: course.courseId,
          name: course.name,
          section: course.section,
          room: course.room,
          studentCount,
          teacher: teacher ? {
            id: teacher.id,
            displayName: teacher.displayName,
            email: teacher.email,
          } : null,
          teacherGoogleId: course.ownerId,
          alreadyExists,
          lastSyncedAt: course.lastSyncedAt,
        };
      }));

      res.json(coursesPreview);
    } catch (error: any) {
      console.error("Classroom courses preview error:", error);
      res.status(500).json({ error: error.message || "Failed to get courses preview" });
    }
  });

  // Create a ClassPilot class from a Google Classroom course (admin action)
  app.post("/api/admin/classroom/create-class", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || !user.schoolId) {
        return res.status(400).json({ error: "User must belong to a school" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, user.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const schoolId = sessionSchoolId;

      const { courseId, teacherId, gradeLevel } = req.body;
      if (!courseId || !teacherId) {
        return res.status(400).json({ error: "courseId and teacherId are required" });
      }

      // Get the course details
      const course = await storage.getClassroomCourse(schoolId, courseId);
      if (!course) {
        return res.status(404).json({ error: "Course not found" });
      }

      // Verify teacher exists and belongs to this school
      const teacher = await storage.getUser(teacherId);
      if (!teacher || teacher.schoolId !== user.schoolId) {
        return res.status(400).json({ error: "Invalid teacher" });
      }

      // Check if a class with this name already exists for this teacher
      const existingGroups = await storage.getGroupsByTeacher(teacherId);
      const existingGroup = existingGroups.find(g => g.name.toLowerCase() === course.name.toLowerCase());
      if (existingGroup) {
        return res.status(409).json({ error: "A class with this name already exists for this teacher" });
      }

      // Create the ClassPilot class
      const newGroup = await storage.createGroup({
        teacherId,
        schoolId,
        name: course.name,
        groupType: "admin_class",
        gradeLevel: gradeLevel || null,
        description: `Imported from Google Classroom${course.section ? `: ${course.section}` : ""}`,
      });

      // Get student IDs from the classroom course and assign them to the group
      const studentIds = await storage.getClassroomCourseStudentIds(schoolId, courseId);
      let assignedCount = 0;
      for (const studentId of studentIds) {
        try {
          // Update student grade level if provided
          if (gradeLevel) {
            await storage.updateStudent(studentId, { gradeLevel });
          }
          await storage.assignStudentToGroup(newGroup.id, studentId);
          assignedCount++;
        } catch (e) {
          // Continue if assignment already exists or fails
        }
      }

      res.json({
        success: true,
        group: newGroup,
        studentsAssigned: assignedCount,
      });
    } catch (error: any) {
      console.error("Create class from classroom error:", error);
      res.status(500).json({ error: error.message || "Failed to create class" });
    }
  });

  // === Google Workspace Directory Routes ===

  // List users from Google Workspace Admin Directory
  app.get("/api/directory/users", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || !user.schoolId) {
        return res.status(400).json({ error: "User must belong to a school" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, user.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const { listDomainUsers } = await import("./directory");
      const domain = req.query.domain as string | undefined;
      const query = req.query.query as string | undefined;

      const result = await listDomainUsers(user.id, domain, query);
      res.json(result);
    } catch (error: any) {
      console.error("Directory users error:", error);
      if (error.code === "NO_TOKENS") {
        return res.status(403).json({ error: error.message, code: "NO_TOKENS" });
      }
      if (error.code === "INSUFFICIENT_PERMISSIONS") {
        return res.status(403).json({ error: error.message, code: "INSUFFICIENT_PERMISSIONS" });
      }
      res.status(500).json({ error: error.message || "Failed to fetch users" });
    }
  });

  // Import students from Google Workspace Directory
  app.post("/api/directory/import", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || !user.schoolId) {
        return res.status(400).json({ error: "User must belong to a school" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, user.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const schoolId = sessionSchoolId;

      const { importStudentsFromDirectory } = await import("./directory");
      const { domain, orgUnitPath, gradeLevel } = req.body;

      const result = await importStudentsFromDirectory(user.id, schoolId, {
        domain,
        orgUnitPath,
        gradeLevel,
      });

      res.json({
        success: true,
        imported: result.imported,
        updated: result.updated,
        skipped: result.skipped,
        errors: result.errors,
      });
    } catch (error: any) {
      console.error("Directory import error:", error);
      if (error.code === "NO_TOKENS") {
        return res.status(403).json({ error: error.message, code: "NO_TOKENS" });
      }
      if (error.code === "INSUFFICIENT_PERMISSIONS") {
        return res.status(403).json({ error: error.message, code: "INSUFFICIENT_PERMISSIONS" });
      }
      res.status(500).json({ error: error.message || "Failed to import students" });
    }
  });

  // Get organization units from Google Workspace
  app.get("/api/directory/orgunits", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, user.schoolId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const { getOrganizationUnits } = await import("./directory");
      const orgUnits = await getOrganizationUnits(user.id);
      res.json({ orgUnits });
    } catch (error: any) {
      console.error("Org units error:", error);
      res.status(500).json({ error: error.message || "Failed to fetch org units" });
    }
  });

  // Update student information (student name, email, and grade level)
  app.patch("/api/students/:studentId", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const { studentId } = req.params;
      
      // Verify student exists and belongs to same school (tenant isolation)
      const existingStudent = await storage.getStudent(studentId);
      if (!existingStudent) {
        return res.status(404).json({ error: "Student not found" });
      }
      
      if (!assertSameSchool(sessionSchoolId, existingStudent.schoolId)) {
        return res.status(404).json({ error: "Student not found" });
      }
      
      const updates: Partial<InsertStudent> = {};
      
      if ('studentName' in req.body) {
        updates.studentName = req.body.studentName;
      }
      if ('gradeLevel' in req.body) {
        updates.gradeLevel = normalizeGradeLevel(req.body.gradeLevel);
      }
      if ('studentEmail' in req.body) {
        const email = req.body.studentEmail?.trim();
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (email && !emailRegex.test(email)) {
          return res.status(400).json({ error: "Invalid email format" });
        }
        updates.studentEmail = email;
      }
      
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }
      
      const student = await storage.updateStudent(studentId, updates);
      
      if (!student) {
        return res.status(404).json({ error: "Student not found" });
      }
      
      // Broadcast update to teachers
      broadcastToTeachers(sessionSchoolId, {
        type: 'student-update',
        deviceId: student.deviceId,
      });
      
      res.json({ success: true, student });
    } catch (error) {
      console.error("Update student error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Create student (admin-only)
  app.post("/api/students", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      const { studentName, studentEmail, gradeLevel } = req.body;
      
      // Validate required fields
      if (!studentName || typeof studentName !== 'string' || !studentName.trim()) {
        return res.status(400).json({ error: "Student name is required" });
      }
      
      if (!studentEmail || typeof studentEmail !== 'string' || !studentEmail.trim()) {
        return res.status(400).json({ error: "Student email is required" });
      }
      
      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const normalizedEmail = studentEmail.trim().toLowerCase();
      if (!emailRegex.test(normalizedEmail)) {
        return res.status(400).json({ error: "Invalid email format" });
      }
      
      // Efficient duplicate check using targeted lookup
      const existingStudent = await storage.getStudentBySchoolEmail(sessionSchoolId, normalizedEmail);
      if (existingStudent) {
        return res.status(400).json({ error: "A student with this email already exists" });
      }
      
      // Prepare insert data conforming to schema
      const insertData: InsertStudent = {
        studentName: studentName.trim(),
        studentEmail: normalizedEmail,
        gradeLevel: gradeLevel?.trim() || null,
        schoolId: sessionSchoolId,
        deviceId: null,
        studentStatus: "offline",
      };
      
      // Validate with zod schema
      const validationResult = insertStudentSchema.safeParse(insertData);
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Validation failed", 
          details: validationResult.error.issues 
        });
      }
      
      // Create the student
      const student = await storage.createStudent(validationResult.data);
      
      res.json({ success: true, student });
    } catch (error) {
      console.error("Create student error:", error);
      if (isLicenseLimitError(error)) {
        return res.status(409).json(buildLicenseLimitResponse(error));
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Delete student (admin-only)
  app.delete("/api/students/:studentId", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      const { studentId } = req.params;
      
      // Validate student ID format
      if (!studentId || typeof studentId !== 'string') {
        return res.status(400).json({ error: "Invalid student ID" });
      }
      
      // Get student info before deletion for broadcast
      const student = await storage.getStudent(studentId);
      if (!student) {
        return res.status(404).json({ error: "Student not found" });
      }
      
      // Verify student belongs to same school (tenant isolation)
      if (!assertSameSchool(sessionSchoolId, student.schoolId)) {
        return res.status(404).json({ error: "Student not found" });
      }
      
      const deleted = await storage.deleteStudent(studentId);
      
      if (!deleted) {
        return res.status(404).json({ error: "Student not found" });
      }
      
      // Broadcast update to teachers using student's actual device ID (if available)
      // This triggers dashboard refresh to remove deleted student
      broadcastToTeachers(sessionSchoolId, {
        type: 'student-update',
        deviceId: student?.deviceId || studentId,
      });
      
      res.json({ success: true });
    } catch (error) {
      console.error("Delete student error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Update device information (device name and class assignment)
  app.patch("/api/devices/:deviceId", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const existingDevice = await storage.getDevice(deviceId);
      if (!existingDevice) {
        return res.status(404).json({ error: "Device not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, existingDevice.schoolId)) {
        return res.status(404).json({ error: "Device not found" });
      }
      
      const updates: Partial<Omit<InsertDevice, 'deviceId'>> = {};
      
      if ('deviceName' in req.body) {
        updates.deviceName = req.body.deviceName || null;
      }
      if ('classId' in req.body) {
        updates.classId = req.body.classId;
      }
      
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }
      
      const updatedDevice = await storage.updateDevice(deviceId, updates);
      
      if (!updatedDevice) {
        return res.status(404).json({ error: "Device not found" });
      }
      
      // Broadcast update to teachers
      broadcastToTeachers(sessionSchoolId, {
        type: 'device-update',
        deviceId: updatedDevice.deviceId,
      });
      
      res.json({ success: true, device: updatedDevice });
    } catch (error) {
      console.error("Update device error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Delete student assignment
  app.delete("/api/students/:studentId", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const { studentId } = req.params;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      // Get student info before deleting for broadcast
      const student = await storage.getStudent(studentId);
      if (student && !assertSameSchool(sessionSchoolId, student.schoolId)) {
        return res.status(404).json({ error: "Student not found" });
      }
      const deviceId = student?.deviceId;
      
      const deleted = await storage.deleteStudent(studentId);
      
      if (!deleted) {
        return res.status(404).json({ error: "Student not found" });
      }
      
      // Broadcast update to teachers
      if (deviceId) {
        broadcastToTeachers(sessionSchoolId, {
          type: 'student-update',
          deviceId,
        });
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Delete student error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Bulk delete students (admin only)
  app.post("/api/admin/students/bulk-delete", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const { studentIds } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      if (!Array.isArray(studentIds) || studentIds.length === 0) {
        return res.status(400).json({ error: "studentIds array is required" });
      }

      const results = {
        deleted: 0,
        failed: 0,
        errors: [] as string[],
      };

      for (const studentId of studentIds) {
        try {
          const student = await storage.getStudent(studentId);
          if (!student) {
            results.failed++;
            continue;
          }

          // Verify student belongs to same school (tenant isolation)
          if (!assertSameSchool(sessionSchoolId, student.schoolId)) {
            results.failed++;
            continue;
          }

          const deleted = await storage.deleteStudent(studentId);
          if (deleted) {
            results.deleted++;
            // Broadcast update to teachers
            broadcastToTeachers(sessionSchoolId, {
              type: 'student-update',
              deviceId: student.deviceId || studentId,
            });
          } else {
            results.failed++;
          }
        } catch (err: any) {
          results.failed++;
          results.errors.push(`Failed to delete ${studentId}: ${err.message}`);
        }
      }

      res.json({ success: true, ...results });
    } catch (error) {
      console.error("Bulk delete students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Bulk update student grades (admin only)
  app.post("/api/admin/students/bulk-update-grade", requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const { studentIds, gradeLevel } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      if (!Array.isArray(studentIds) || studentIds.length === 0) {
        return res.status(400).json({ error: "studentIds array is required" });
      }

      if (gradeLevel === undefined) {
        return res.status(400).json({ error: "gradeLevel is required" });
      }

      const normalizedGrade = normalizeGradeLevel(gradeLevel);

      const results = {
        updated: 0,
        failed: 0,
        errors: [] as string[],
      };

      for (const studentId of studentIds) {
        try {
          const student = await storage.getStudent(studentId);
          if (!student) {
            results.failed++;
            continue;
          }

          // Verify student belongs to same school (tenant isolation)
          if (!assertSameSchool(sessionSchoolId, student.schoolId)) {
            results.failed++;
            continue;
          }

          const updated = await storage.updateStudent(studentId, { gradeLevel: normalizedGrade });
          if (updated) {
            results.updated++;
            // Broadcast update to teachers
            broadcastToTeachers(sessionSchoolId, {
              type: 'student-update',
              deviceId: student.deviceId || studentId,
            });
          } else {
            results.failed++;
          }
        } catch (err: any) {
          results.failed++;
          results.errors.push(`Failed to update ${studentId}: ${err.message}`);
        }
      }

      res.json({ success: true, ...results });
    } catch (error) {
      console.error("Bulk update student grades error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Delete device and all its student assignments
  app.delete("/api/devices/:deviceId", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const device = await storage.getDevice(deviceId);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, device.schoolId)) {
        return res.status(404).json({ error: "Device not found" });
      }
      
      const deleted = await storage.deleteDevice(deviceId);
      
      if (!deleted) {
        return res.status(404).json({ error: "Device not found" });
      }
      
      // Broadcast update to teachers
      broadcastToTeachers(sessionSchoolId, {
        type: 'device-deleted',
        deviceId,
      });
      
      res.json({ success: true });
    } catch (error) {
      console.error("Delete device error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get heartbeat history for a specific device
  app.get("/api/heartbeats/:deviceId", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const limit = parseInt(req.query.limit as string) || 1000; // Fetch more history to show more sessions
      
      const device = await storage.getDevice(deviceId);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, device.schoolId)) {
        return res.status(404).json({ error: "Device not found" });
      }

      const heartbeats = await storage.getHeartbeatsByDevice(deviceId, limit);
      res.json(heartbeats);
    } catch (error) {
      console.error("Get heartbeats error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get website duration analytics for a student or all students
  app.get("/api/student-analytics/:studentId", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const { studentId } = req.params;
      const isAllStudents = studentId === "all";
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      if (!isAllStudents) {
        const student = await storage.getStudent(studentId);
        if (!student) {
          return res.status(404).json({ error: "Student not found" });
        }
        if (!assertSameSchool(sessionSchoolId, student.schoolId)) {
          return res.status(404).json({ error: "Student not found" });
        }
      }
      
      // Get heartbeats for the last 24 hours (or custom range)
      const allHeartbeats = await storage.getHeartbeatsBySchool(sessionSchoolId);
      const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
      
      // Filter heartbeats by student and time range
      let filteredHeartbeats = allHeartbeats.filter(hb => {
        const timestamp = new Date(hb.timestamp).getTime();
        if (timestamp < cutoffTime) return false;
        
        if (isAllStudents) return hb.schoolId === sessionSchoolId;
        return hb.studentId === studentId;
      });
      
      // Group by URL domain and calculate total duration
      const urlDurations = new Map<string, number>();
      
      // Sort by timestamp
      filteredHeartbeats.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      
      // Calculate duration for each URL
      for (let i = 0; i < filteredHeartbeats.length; i++) {
        const current = filteredHeartbeats[i];
        
        // Skip heartbeats with no URL (chrome-internal URLs filtered by extension)
        if (!current.activeTabUrl) continue;
        
        let duration = 10; // Default 10 seconds per heartbeat
        
        // If there's a next heartbeat from the same device with the same URL, calculate exact duration
        if (i < filteredHeartbeats.length - 1) {
          const next = filteredHeartbeats[i + 1];
          if (current.deviceId === next.deviceId && current.activeTabUrl === next.activeTabUrl) {
            const timeDiff = (new Date(next.timestamp).getTime() - new Date(current.timestamp).getTime()) / 1000;
            // Cap at 60 seconds to avoid inflated durations from gaps
            duration = Math.min(timeDiff, 60);
          }
        }
        
        // Extract and clean domain from URL
        let domain = current.activeTabUrl;
        try {
          const url = new URL(current.activeTabUrl);
          let hostname = url.hostname;
          
          // Clean up common domain patterns
          if (hostname.startsWith('www.')) {
            domain = hostname.substring(4);
          } else if (hostname.includes('chrome://')) {
            domain = url.protocol.replace(':', '');
          } else {
            domain = hostname;
          }
        } catch {
          // If URL parsing fails, clean up common patterns
          if (domain && domain.includes('chrome://')) {
            domain = 'chrome (extensions)';
          }
        }
        
        const currentDuration = urlDurations.get(domain) || 0;
        urlDurations.set(domain, currentDuration + duration);
      }
      
      // Convert to array and sort by duration
      const websiteData = Array.from(urlDurations.entries())
        .map(([domain, duration]) => ({
          name: domain,
          value: Math.round(duration),
        }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 10); // Top 10 websites
      
      res.json(websiteData);
    } catch (error) {
      console.error("Get student analytics error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });


  // Settings endpoints
  // GET: Teachers can read settings (for dashboard features like max tabs), admins can too
  app.get("/api/settings", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      logSettingsSchoolId(sessionSchoolId);
      const settings = await storage.ensureSettingsForSchool(sessionSchoolId);
      res.json(settings);
    } catch (error) {
      console.error("Get settings error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/settings", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      logSettingsSchoolId(sessionSchoolId);
      const data = insertSettingsSchema.parse({
        ...req.body,
        schoolId: sessionSchoolId,
      }) as typeof settingsTable.$inferInsert;
      const { schoolId: _ignoredSchoolId, ...payload } = data;
      const settings = await storage.upsertSettingsForSchool(sessionSchoolId, payload);

      // Broadcast updated blacklist to all connected students in this school
      if (settings.blockedDomains) {
        broadcastToStudents(sessionSchoolId, {
          type: 'update-global-blacklist',
          blockedDomains: settings.blockedDomains
        });
        console.log(`[Settings] Broadcasted global blacklist update to school ${sessionSchoolId}:`, settings.blockedDomains);
      }

      res.json(settings);
    } catch (error) {
      console.error("Update settings error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.patch("/api/settings", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      logSettingsSchoolId(sessionSchoolId);
      const currentSettings = await storage.ensureSettingsForSchool(sessionSchoolId);

      // Merge current settings with request body for partial update
      const updatedData = { ...currentSettings, ...req.body, schoolId: currentSettings.schoolId };
      const data = insertSettingsSchema.parse(updatedData) as typeof settingsTable.$inferInsert;
      const { schoolId: _ignoredSchoolId, ...payload } = data;
      const settings = await storage.upsertSettingsForSchool(sessionSchoolId, payload);

      // Log settings update (non-blocking)
      logAuditFromRequest(req, AuditAction.SETTINGS_UPDATE, {
        entityType: 'settings',
        entityId: sessionSchoolId,
        changes: { old: currentSettings, new: settings },
      }).catch(() => {}); // Ignore errors

      // Broadcast updated blacklist to all connected students in this school
      if (settings.blockedDomains) {
        broadcastToStudents(sessionSchoolId, {
          type: 'update-global-blacklist',
          blockedDomains: settings.blockedDomains
        });
        console.log(`[Settings] Broadcasted global blacklist update to school ${sessionSchoolId}:`, settings.blockedDomains);
      }

      res.json(settings);
    } catch (error) {
      console.error("Update settings error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Teacher Settings endpoints
  app.get("/api/teacher/settings", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const teacher = await storage.getUser(teacherId);
      if (!teacher) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, teacher.schoolId)) {
        return res.status(404).json({ error: "Teacher not found" });
      }
      
      const teacherSettings = await storage.getTeacherSettings(teacherId);
      res.json(teacherSettings || null);
    } catch (error) {
      console.error("Get teacher settings error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/teacher/settings", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const teacher = await storage.getUser(teacherId);
      if (!teacher) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, teacher.schoolId)) {
        return res.status(404).json({ error: "Teacher not found" });
      }
      
      const data = { ...req.body, teacherId };
      const teacherSettings = await storage.upsertTeacherSettings(data);
      res.json(teacherSettings);
    } catch (error) {
      console.error("Update teacher settings error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Teacher-Student assignment endpoints
  app.get("/api/teacher/students", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const teacher = await storage.getUser(teacherId);
      if (!teacher) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, teacher.schoolId)) {
        return res.status(404).json({ error: "Teacher not found" });
      }
      
      const studentIds = await storage.getTeacherStudents(teacherId);
      const students = await Promise.all(
        studentIds.map(id => storage.getStudent(id))
      );
      res.json(students.filter(s => s !== undefined && assertSameSchool(sessionSchoolId, s.schoolId)));
    } catch (error) {
      console.error("Get teacher students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/teacher/students/:studentId/assign", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const { studentId } = req.params;
      const student = await storage.getStudent(studentId);
      if (!student) {
        return res.status(404).json({ error: "Student not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, student.schoolId)) {
        return res.status(404).json({ error: "Student not found" });
      }
      const assignment = await storage.assignStudentToTeacher(teacherId, studentId);
      res.json(assignment);
    } catch (error) {
      console.error("Assign student error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/teacher/students/:studentId/unassign", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const { studentId } = req.params;
      const student = await storage.getStudent(studentId);
      if (!student) {
        return res.status(404).json({ error: "Student not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, student.schoolId)) {
        return res.status(404).json({ error: "Student not found" });
      }
      const success = await storage.unassignStudentFromTeacher(teacherId, studentId);
      
      if (success) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: "Assignment not found" });
      }
    } catch (error) {
      console.error("Unassign student error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Dashboard Tabs endpoints - User-customizable filter tabs
  app.get("/api/teacher/dashboard-tabs", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      let tabs = await storage.getDashboardTabs(teacherId);
      
      // Auto-generate default grade-level tabs if none exist
      if (tabs.length === 0) {
        const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
        const settings = await storage.ensureSettingsForSchool(sessionSchoolId);
        const gradeLevels = settings?.gradeLevels || ["6", "7", "8", "9", "10", "11", "12"];
        
        // Create "All Grades" tab first
        await storage.createDashboardTab({
          teacherId,
          label: "All Grades",
          filterType: "all",
          filterValue: null,
          order: "0",
        });
        
        // Create grade-level tabs
        for (let i = 0; i < gradeLevels.length; i++) {
          const grade = gradeLevels[i];
          const label = grade === "K" ? "Kindergarten" : `Grade ${grade}`;
          await storage.createDashboardTab({
            teacherId,
            label,
            filterType: "grade",
            filterValue: { grade },
            order: String(i + 1),
          });
        }
        
        // Fetch the newly created tabs
        tabs = await storage.getDashboardTabs(teacherId);
      }
      
      res.json(tabs);
    } catch (error) {
      console.error("Get dashboard tabs error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/teacher/dashboard-tabs", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const data = insertDashboardTabSchema.parse({ ...req.body, teacherId });
      const tab = await storage.createDashboardTab(data);
      res.json(tab);
    } catch (error) {
      console.error("Create dashboard tab error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.patch("/api/teacher/dashboard-tabs/:id", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const { id } = req.params;
      
      // Verify ownership
      const existingTab = await storage.getDashboardTab(id);
      if (!existingTab || existingTab.teacherId !== teacherId) {
        return res.status(404).json({ error: "Dashboard tab not found" });
      }
      
      const data = { ...req.body, teacherId };
      const tab = await storage.updateDashboardTab(id, data);
      res.json(tab);
    } catch (error) {
      console.error("Update dashboard tab error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.delete("/api/teacher/dashboard-tabs/:id", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const { id } = req.params;
      
      // Verify ownership
      const existingTab = await storage.getDashboardTab(id);
      if (!existingTab || existingTab.teacherId !== teacherId) {
        return res.status(404).json({ error: "Dashboard tab not found" });
      }
      
      const success = await storage.deleteDashboardTab(id);
      
      if (success) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: "Dashboard tab not found" });
      }
    } catch (error) {
      console.error("Delete dashboard tab error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Groups (Class Rosters) endpoints
  app.get("/api/teacher/groups", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const sessionRole = req.session.role === "admin" ? "school_admin" : req.session.role;
      const groups =
        sessionRole === "school_admin" || sessionRole === "super_admin"
          ? await storage.getGroupsBySchool(sessionSchoolId)
          : await storage.getGroupsByTeacher(userId);
      res.json(groups.filter(group => assertSameSchool(sessionSchoolId, group.schoolId)));
    } catch (error) {
      console.error("Get groups error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/teacher/groups", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const sessionRole = req.session.role === "admin" ? "school_admin" : req.session.role;
      
      // Determine target teacherId
      let targetTeacherId = req.body.teacherId;
      
      // If not admin, force teacherId to be current user
      if (sessionRole !== 'school_admin' && sessionRole !== 'super_admin') {
        targetTeacherId = userId;
      }
      
      // Validate targetTeacherId is provided
      if (!targetTeacherId) {
        return res.status(400).json({ error: "teacherId is required" });
      }
      
      // Set default groupType if not provided
      const groupType = req.body.groupType || 
        (sessionRole === 'school_admin' || sessionRole === 'super_admin' ? 'admin_class' : 'teacher_created');

      if (targetTeacherId) {
        const targetTeacher = await storage.getUser(targetTeacherId);
        if (!targetTeacher) {
          return res.status(404).json({ error: "Teacher not found" });
        }
        if (!assertSameSchool(sessionSchoolId, targetTeacher.schoolId)) {
          return res.status(404).json({ error: "Teacher not found" });
        }
      }
      
      const data = insertGroupSchema.parse({ 
        ...req.body, 
        teacherId: targetTeacherId,
        schoolId: sessionSchoolId,
        groupType 
      });
      const group = await storage.createGroup(data);
      res.json(group);
    } catch (error) {
      console.error("Create group error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.patch("/api/teacher/groups/:id", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const sessionRole = req.session.role === "admin" ? "school_admin" : req.session.role;
      
      const { id } = req.params;
      
      // Verify ownership (admins can edit any group)
      const existingGroup = await storage.getGroup(id);
      if (!existingGroup) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      if (!assertSameSchool(sessionSchoolId, existingGroup.schoolId)) {
        return res.status(404).json({ error: "Group not found" });
      }

      if (sessionRole !== "school_admin" && sessionRole !== "super_admin" && existingGroup.teacherId !== userId) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      const group = await storage.updateGroup(id, { ...req.body, schoolId: existingGroup.schoolId });
      res.json(group);
    } catch (error) {
      console.error("Update group error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.delete("/api/teacher/groups/:id", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const sessionRole = req.session.role === "admin" ? "school_admin" : req.session.role;
      
      const { id } = req.params;
      
      // Verify ownership (admins can delete any group)
      const existingGroup = await storage.getGroup(id);
      if (!existingGroup) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      if (!assertSameSchool(sessionSchoolId, existingGroup.schoolId)) {
        return res.status(404).json({ error: "Group not found" });
      }

      if (sessionRole !== "school_admin" && sessionRole !== "super_admin" && existingGroup.teacherId !== userId) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      const success = await storage.deleteGroup(id);
      res.json({ success });
    } catch (error) {
      console.error("Delete group error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Group students endpoints
  app.get("/api/groups/:groupId/students", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const sessionRole = req.session.role === "admin" ? "school_admin" : req.session.role;
      
      const { groupId } = req.params;
      
      // Verify ownership - admins can view any group, teachers only their own
      const group = await storage.getGroup(groupId);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }
      if (!assertSameSchool(sessionSchoolId, group.schoolId)) {
        return res.status(404).json({ error: "Group not found" });
      }
      if (sessionRole !== 'school_admin' && sessionRole !== 'super_admin' && group.teacherId !== userId) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      const studentIds = await storage.getGroupStudents(groupId);
      const students = await Promise.all(studentIds.map(id => storage.getStudent(id)));
      res.json(students.filter(s => s !== undefined && assertSameSchool(sessionSchoolId, s.schoolId)));
    } catch (error) {
      console.error("Get group students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/groups/:groupId/students/:studentId", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const sessionRole = req.session.role === "admin" ? "school_admin" : req.session.role;
      
      const { groupId, studentId } = req.params;
      
      // Verify ownership - admins can manage any group, teachers only their own
      const group = await storage.getGroup(groupId);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }
      if (!assertSameSchool(sessionSchoolId, group.schoolId)) {
        return res.status(404).json({ error: "Group not found" });
      }
      if (sessionRole !== 'school_admin' && sessionRole !== 'super_admin' && group.teacherId !== userId) {
        return res.status(404).json({ error: "Group not found" });
      }

      const student = await storage.getStudent(studentId);
      if (!student) {
        return res.status(404).json({ error: "Student not found" });
      }
      if (!assertSameSchool(sessionSchoolId, student.schoolId)) {
        return res.status(404).json({ error: "Student not found" });
      }
      
      const assignment = await storage.assignStudentToGroup(groupId, studentId);
      res.json(assignment);
    } catch (error) {
      console.error("Assign student to group error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/groups/:groupId/students/:studentId", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const sessionRole = req.session.role === "admin" ? "school_admin" : req.session.role;
      
      const { groupId, studentId } = req.params;
      
      // Verify ownership - admins can manage any group, teachers only their own
      const group = await storage.getGroup(groupId);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }
      if (!assertSameSchool(sessionSchoolId, group.schoolId)) {
        return res.status(404).json({ error: "Group not found" });
      }
      if (sessionRole !== 'school_admin' && sessionRole !== 'super_admin' && group.teacherId !== userId) {
        return res.status(404).json({ error: "Group not found" });
      }

      const student = await storage.getStudent(studentId);
      if (!student) {
        return res.status(404).json({ error: "Student not found" });
      }
      if (!assertSameSchool(sessionSchoolId, student.schoolId)) {
        return res.status(404).json({ error: "Student not found" });
      }
      
      const success = await storage.unassignStudentFromGroup(groupId, studentId);
      res.json({ success });
    } catch (error) {
      console.error("Unassign student from group error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Session endpoints
  app.post("/api/sessions/start", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      const { groupId } = req.body;
      
      // Verify group ownership
      const group = await storage.getGroup(groupId);
      if (!group || group.teacherId !== teacherId) {
        return res.status(404).json({ error: "Group not found" });
      }
      if (!assertSameSchool(sessionSchoolId, group.schoolId)) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      // End any existing active session for this teacher
      const existingSession = await storage.getActiveSessionByTeacher(teacherId);
      if (existingSession) {
        await storage.endSession(existingSession.id);
      }
      
      // Start new session
      const session = await storage.startSession({ groupId, teacherId });
      res.json(session);
    } catch (error) {
      console.error("Start session error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/sessions/end", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const activeSession = await storage.getActiveSessionByTeacher(teacherId);
      if (!activeSession) {
        return res.status(404).json({ error: "No active session found" });
      }

      // Before ending session, broadcast remove-block-list to all students in the group
      // Teacher block lists are session-based and should be cleared when session ends
      if (activeSession.groupId) {
        try {
          const studentIds = await storage.getGroupStudents(activeSession.groupId);
          let sentCount = 0;
          for (const studentId of studentIds) {
            const student = await storage.getStudent(studentId);
            if (student?.deviceId) {
              sendToDevice(sessionSchoolId, student.deviceId, {
                type: 'remote-control',
                command: 'remove-block-list',
                data: {}
              });
              sentCount++;
            }
          }
          console.log(`[Session End] Broadcast remove-block-list to ${sentCount} devices in group ${activeSession.groupId}`);
        } catch (err) {
          // Don't fail the session end if broadcast fails
          console.error('[Session End] Failed to broadcast remove-block-list:', err);
        }
      }

      const session = await storage.endSession(activeSession.id);
      res.json(session);
    } catch (error) {
      console.error("End session error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/sessions/active", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const session = await storage.getActiveSessionByTeacher(teacherId);
      res.json(session || null);
    } catch (error) {
      console.error("Get active session error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/sessions/all", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireAdminRole, async (req, res) => {
    try {
      // Admin-only endpoint to view all active sessions school-wide
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const sessions = await storage.getActiveSessions(sessionSchoolId);
      res.json(sessions);
    } catch (error) {
      console.error("Get all sessions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Flight Paths CRUD endpoints
  app.get("/api/flight-paths", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const sessionRole = req.session.role === "admin" ? "school_admin" : req.session.role;
      const allFlightPaths = await storage.getFlightPathsBySchool(sessionSchoolId);
      
      // Admins see all flight paths; teachers see only their own + school-wide defaults
      const filteredFlightPaths = (sessionRole === "school_admin" || sessionRole === "super_admin")
        ? allFlightPaths
        : allFlightPaths.filter(fp => fp.teacherId === userId || fp.teacherId === null);
      
      res.json(filteredFlightPaths);
    } catch (error) {
      console.error("Get flight paths error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/flight-paths/:id", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const flightPath = await storage.getFlightPath(req.params.id);
      if (!flightPath) {
        return res.status(404).json({ error: "Flight Path not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, flightPath.schoolId)) {
        return res.status(404).json({ error: "Flight Path not found" });
      }
      res.json(flightPath);
    } catch (error) {
      console.error("Get flight path error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/flight-paths", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      // Make schoolId optional for teacher-scoped Flight Paths
      const flightPathSchema = insertFlightPathSchema.extend({
        schoolId: z.string().optional(),
      });
      const data = flightPathSchema.parse(req.body);
      
      // Ensure blockedDomains defaults to empty array if not provided
      const flightPath = await storage.createFlightPath({
        ...data,
        schoolId: sessionSchoolId,
        teacherId: data.teacherId ?? teacherId,
        blockedDomains: data.blockedDomains ?? []
      });
      res.json(flightPath);
    } catch (error) {
      console.error("Create flight path error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.patch("/api/flight-paths/:id", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const updates = insertFlightPathSchema.partial().parse(req.body);
      
      // If blockedDomains is not provided, explicitly set it to empty array
      // to clear any previously saved blocked domains
      if (!('blockedDomains' in req.body)) {
        updates.blockedDomains = [];
      }
      
      const existing = await storage.getFlightPath(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: "Flight Path not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, existing.schoolId)) {
        return res.status(404).json({ error: "Flight Path not found" });
      }

      const flightPath = await storage.updateFlightPath(req.params.id, { ...updates, schoolId: existing.schoolId });
      if (!flightPath) {
        return res.status(404).json({ error: "Flight Path not found" });
      }
      res.json(flightPath);
    } catch (error) {
      console.error("Update flight path error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.delete("/api/flight-paths/:id", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const existing = await storage.getFlightPath(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: "Flight Path not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, existing.schoolId)) {
        return res.status(404).json({ error: "Flight Path not found" });
      }
      const success = await storage.deleteFlightPath(req.params.id);
      if (!success) {
        return res.status(404).json({ error: "Flight Path not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Delete flight path error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Block Lists CRUD endpoints (teacher-scoped)
  app.get("/api/block-lists", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const blockLists = await storage.getBlockListsByTeacher(userId);
      res.json(blockLists);
    } catch (error) {
      console.error("Get block lists error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/block-lists/:id", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const blockList = await storage.getBlockList(req.params.id);
      if (!blockList) {
        return res.status(404).json({ error: "Block List not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, blockList.schoolId)) {
        return res.status(404).json({ error: "Block List not found" });
      }
      res.json(blockList);
    } catch (error) {
      console.error("Get block list error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/block-lists", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      const { name, description, blockedDomains } = req.body;
      if (!name || typeof name !== "string") {
        return res.status(400).json({ error: "Name is required" });
      }

      const domainsArray = Array.isArray(blockedDomains) ? blockedDomains.filter((d: unknown) => typeof d === "string") : [];

      const blockList = await storage.createBlockList({
        name: name.trim(),
        description: description || null,
        schoolId: sessionSchoolId,
        teacherId: teacherId,
        blockedDomains: domainsArray
      });
      res.json(blockList);
    } catch (error) {
      console.error("Create block list error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.patch("/api/block-lists/:id", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const updates = insertBlockListSchema.partial().parse(req.body);

      const existing = await storage.getBlockList(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: "Block List not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, existing.schoolId)) {
        return res.status(404).json({ error: "Block List not found" });
      }
      if (existing.teacherId !== req.session?.userId) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const blockList = await storage.updateBlockList(req.params.id, updates);
      res.json(blockList);
    } catch (error) {
      console.error("Update block list error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.delete("/api/block-lists/:id", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const existing = await storage.getBlockList(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: "Block List not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, existing.schoolId)) {
        return res.status(404).json({ error: "Block List not found" });
      }
      if (existing.teacherId !== req.session?.userId) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const success = await storage.deleteBlockList(req.params.id);
      if (!success) {
        return res.status(404).json({ error: "Block List not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Delete block list error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Apply/Remove Block List endpoints
  app.post("/api/block-lists/:id/apply", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const blockList = await storage.getBlockList(req.params.id);
      if (!blockList) {
        return res.status(404).json({ error: "Block List not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, blockList.schoolId)) {
        return res.status(404).json({ error: "Block List not found" });
      }

      const { targetDeviceIds } = req.body as { targetDeviceIds?: string[] };

      let sentTo = 0;
      const blockListMessage = {
        type: 'remote-control',
        command: {
          type: 'apply-block-list',
          data: {
            blockListId: blockList.id,
            blockListName: blockList.name,
            blockedDomains: blockList.blockedDomains || []
          }
        }
      };

      if (targetDeviceIds && Array.isArray(targetDeviceIds) && targetDeviceIds.length > 0) {
        // Send to specific devices
        for (const deviceId of targetDeviceIds) {
          sendToDevice(sessionSchoolId, deviceId, blockListMessage);
          sentTo++;
        }
      } else {
        // Broadcast to all students
        sentTo = broadcastToStudents(sessionSchoolId, blockListMessage);
      }

      console.log(`[Block List] Applied "${blockList.name}" to ${sentTo} device(s)`);

      res.json({
        success: true,
        sentTo,
        message: `Applied "${blockList.name}" to ${sentTo} device(s)`
      });
    } catch (error) {
      console.error("Apply block list error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/block-lists/remove", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const { targetDeviceIds } = req.body as { targetDeviceIds?: string[] };

      let sentTo = 0;
      const removeMessage = {
        type: 'remote-control',
        command: {
          type: 'remove-block-list'
        }
      };

      if (targetDeviceIds && Array.isArray(targetDeviceIds) && targetDeviceIds.length > 0) {
        // Send to specific devices
        for (const deviceId of targetDeviceIds) {
          sendToDevice(sessionSchoolId, deviceId, removeMessage);
          sentTo++;
        }
      } else {
        // Broadcast to all students
        sentTo = broadcastToStudents(sessionSchoolId, removeMessage);
      }

      console.log(`[Block List] Removed from ${sentTo} device(s)`);

      res.json({
        success: true,
        sentTo,
        message: `Removed block list from ${sentTo} device(s)`
      });
    } catch (error) {
      console.error("Remove block list error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Student Groups CRUD endpoints
  app.get("/api/groups", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const sessionRole = req.session.role === "admin" ? "school_admin" : req.session.role;
      const allGroups = await storage.getStudentGroupsBySchool(sessionSchoolId);
      
      // Admins see all groups; teachers see only their own + school-wide defaults
      const filteredGroups = (sessionRole === "school_admin" || sessionRole === "super_admin")
        ? allGroups
        : allGroups.filter(group => group.teacherId === userId || group.teacherId === null);
      
      res.json(filteredGroups);
    } catch (error) {
      console.error("Get groups error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/groups/:id", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const group = await storage.getStudentGroup(req.params.id);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, group.schoolId)) {
        return res.status(404).json({ error: "Group not found" });
      }
      res.json(group);
    } catch (error) {
      console.error("Get group error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/groups", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const data = insertStudentGroupSchema.parse(req.body);
      const group = await storage.createStudentGroup({
        ...data,
        teacherId: data.teacherId ?? teacherId,
        schoolId: res.locals.schoolId ?? req.session.schoolId!,
      });
      res.json(group);
    } catch (error) {
      console.error("Create group error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.patch("/api/groups/:id", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const updates = insertGroupSchema.partial().parse(req.body);
      const existing = await storage.getGroup(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: "Group not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, existing.schoolId)) {
        return res.status(404).json({ error: "Group not found" });
      }
      const group = await storage.updateGroup(req.params.id, { ...updates, schoolId: existing.schoolId });
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }
      res.json(group);
    } catch (error) {
      console.error("Update group error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.delete("/api/groups/:id", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const existing = await storage.getGroup(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: "Group not found" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      if (!assertSameSchool(sessionSchoolId, existing.schoolId)) {
        return res.status(404).json({ error: "Group not found" });
      }
      const success = await storage.deleteGroup(req.params.id);
      if (!success) {
        return res.status(404).json({ error: "Group not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Delete group error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all rosters/classes
  app.get("/api/rosters", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const rosters = await storage.getRostersBySchool(sessionSchoolId);
      const devices = await storage.getDevicesBySchool(sessionSchoolId);
      const schoolDeviceIds = new Set(devices.map(d => d.deviceId));
      const filtered = rosters.filter(roster => roster.deviceIds.some(deviceId => schoolDeviceIds.has(deviceId)));
      res.json(filtered);
    } catch (error) {
      console.error("Get rosters error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Create or update a roster/class
  app.post("/api/rosters", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { className, classId } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      if (!className || typeof className !== 'string') {
        return res.status(400).json({ error: "Class name is required" });
      }
      
      if (!classId || typeof classId !== 'string') {
        return res.status(400).json({ error: "Class ID is required" });
      }
      
      // Check for duplicate classId
      const existing = await storage.getRoster(classId);
      if (existing) {
        const devices = await storage.getDevicesBySchool(sessionSchoolId);
        const schoolDeviceIds = new Set(devices.map(d => d.deviceId));
        const belongsToSchool = existing.deviceIds.some(deviceId => schoolDeviceIds.has(deviceId));
        if (belongsToSchool) {
          return res.status(400).json({ error: "A class with this name already exists" });
        }
      }
      const rosterData: InsertRoster = {
        classId,
        className,
        deviceIds: [],
      };
      
      const roster = await storage.upsertRoster(rosterData);
      res.json(roster);
    } catch (error) {
      console.error("Create roster error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Roster upload endpoint
  app.post("/api/roster/upload", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      // In a real implementation, this would parse the CSV file
      // For now, we'll accept JSON data
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const data = insertRosterSchema.parse(req.body);
      const devices = await storage.getDevicesBySchool(sessionSchoolId);
      const deviceIds = data.deviceIds ?? [];
      const schoolDeviceIds = new Set(devices.map(device => device.deviceId));
      const invalidDeviceId = deviceIds.find(deviceId => !schoolDeviceIds.has(deviceId));
      if (invalidDeviceId) {
        return res.status(404).json({ error: "Device not found" });
      }
      const existingRoster = await storage.getRoster(data.classId);
      if (existingRoster) {
        const belongsToSchool = existingRoster.deviceIds.some(deviceId => schoolDeviceIds.has(deviceId));
        if (!belongsToSchool) {
          return res.status(404).json({ error: "Roster not found" });
        }
      }
      const roster = await storage.upsertRoster(data);
      res.json({ success: true, roster });
    } catch (error) {
      console.error("Roster upload error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Export activity CSV endpoint with date range filtering
  app.get("/api/export/activity", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : new Date(Date.now() - 24 * 60 * 60 * 1000);
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();
      
      // Get all heartbeats within date range
      const allHeartbeats = await storage.getHeartbeatsBySchool(sessionSchoolId);
      const filteredHeartbeats = allHeartbeats.filter(hb => {
        const timestamp = new Date(hb.timestamp);
        return timestamp >= startDate && timestamp <= endDate;
      });
      
      // Get all students to map deviceId to studentName
      const students = await storage.getStudentsBySchool(sessionSchoolId);
      const studentMap = new Map(students.map(s => [s.deviceId, s.studentName]));
      
      // Calculate URL sessions with duration for each device
      const deviceSessions = groupSessionsByDevice(filteredHeartbeats);
      
      // Prepare data for CSV with duration information
      const data: Record<string, string | number>[] = [];
      Array.from(deviceSessions.entries()).forEach(([deviceId, sessions]) => {
        sessions.forEach(session => {
          data.push({
            'Device ID': deviceId,
            'Student Name': studentMap.get(deviceId) || deviceId,
            'Start Time': session.startTime.toISOString(),
            'End Time': session.endTime.toISOString(),
            'Duration': formatDuration(session.durationSeconds),
            'Duration (seconds)': session.durationSeconds,
            'URL': session.url,
            'Tab Title': session.title,
          });
        });
      });
      
      // Sort by device ID and start time
      data.sort((a, b) => {
        if (a['Device ID'] !== b['Device ID']) {
          return String(a['Device ID']).localeCompare(String(b['Device ID']));
        }
        return new Date(a['Start Time']).getTime() - new Date(b['Start Time']).getTime();
      });
      
      const columns = [
        'Device ID',
        'Student Name',
        'Start Time',
        'End Time',
        'Duration',
        'Duration (seconds)',
        'URL',
        'Tab Title',
      ];

      const csv = stringifyCsv(data, columns);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=activity-export-${new Date().toISOString().split('T')[0]}.csv`);
      res.send(csv);
    } catch (error) {
      console.error("Export activity error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Legacy export endpoint (for backward compatibility)
  app.get("/api/export/csv", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      const schoolStudents = await storage.getStudentsBySchool(sessionSchoolId);
      const statuses = await storage.getStudentStatusesBySchool(sessionSchoolId);
      
      const columns = [
        "Device ID",
        "Student Name",
        "Class ID",
        "Last Active Tab",
        "Last URL",
        "Last Seen",
        "Status",
      ];

      const data = statuses.flatMap((status) => {
        const student = schoolStudents.find((s) => s.deviceId === status.deviceId);
        if (!student) {
          return [];
        }

        return [{
          "Device ID": status.deviceId,
          "Student Name": status.studentName,
          "Class ID": status.classId,
          "Last Active Tab": status.activeTabTitle,
          "Last URL": status.activeTabUrl,
          "Last Seen": new Date(status.lastSeenAt).toISOString(),
          "Status": status.status,
        }];
      });

      const csv = stringifyCsv(data, columns);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=activity-export.csv');
      res.send(csv);
    } catch (error) {
      console.error("Export error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Remote Control API Routes (Phase 1: GoGuardian-style features)
  
  // Open Tab - Push URL to all students or specific students
  app.post("/api/remote/open-tab", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { url, targetDeviceIds } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }
      
      // Broadcast to targeted students or all students
      const sentCount = broadcastToStudents(sessionSchoolId, {
        type: 'remote-control',
        command: {
          type: 'open-tab',
          data: { url },
        },
      }, undefined, targetDeviceIds);
      
      console.log(`Open tab command sent to ${sentCount} local device(s)${isRedisEnabled() ? ' (also published to Redis)' : ''}`);

      // When Redis pub/sub is enabled, sentCount only reflects local connections.
      // The message is also published to Redis for other instances, so we can't
      // accurately determine the total recipients. Show a generic success message.
      if (isRedisEnabled()) {
        const target = targetDeviceIds && targetDeviceIds.length > 0
          ? 'selected device(s)'
          : 'connected device(s)';
        return res.json({ success: true, sentCount, message: `Opening ${url} on ${target}` });
      }

      // Single-instance mode: sentCount is accurate
      if (sentCount === 0) {
        return res.status(200).json({
          success: true,
          sentCount: 0,
          message: `No student devices are currently connected. Make sure students have the Chrome extension installed and running.`
        });
      }

      const target = targetDeviceIds && targetDeviceIds.length > 0
        ? `${sentCount} selected device(s)`
        : `${sentCount} connected device(s)`;
      res.json({ success: true, sentCount, message: `Opened ${url} on ${target}` });
    } catch (error) {
      console.error("Open tab error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  // Close Tabs - Close all or specific tabs
  app.post("/api/remote/close-tabs", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { closeAll, pattern, specificUrls, allowedDomains, targetDeviceIds, tabsToClose } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      // Reject if new paradigm is mixed with old parameters
      if (tabsToClose && (specificUrls || targetDeviceIds || closeAll || pattern || allowedDomains)) {
        return res.status(400).json({ error: "Cannot mix tabsToClose with closeAll/pattern/specificUrls/allowedDomains/targetDeviceIds" });
      }
      
      let sentCount = 0;
      let message = "";
      
      // New paradigm: per-device tab closure
      if (tabsToClose && Array.isArray(tabsToClose)) {
        // Validate tabsToClose structure (strict validation for non-empty strings)
        const tabsToCloseSchema = z.array(z.object({
          deviceId: z.string({required_error: "deviceId is required"}).min(1).trim().refine(val => val.length > 0, {
            message: "deviceId cannot be empty or whitespace",
          }),
          url: z.string({required_error: "url is required"}).min(1).trim().refine(val => val.length > 0, {
            message: "url cannot be empty or whitespace",
          }),
        }).strict()); // Reject extra properties
        
        const validation = tabsToCloseSchema.safeParse(tabsToClose);
        if (!validation.success) {
          return res.status(400).json({ 
            error: "Invalid tabsToClose format - deviceId and url must be non-empty strings", 
            details: validation.error.errors 
          });
        }
        
        // Deduplicate entries (same deviceId + url)
        const seen = new Set<string>();
        const dedupedTabs: Array<{deviceId: string; url: string}> = [];
        validation.data.forEach(({ deviceId, url }) => {
          const key = `${deviceId}|${url}`;
          if (!seen.has(key)) {
            seen.add(key);
            dedupedTabs.push({ deviceId, url });
          }
        });
        
        // Group tabs by deviceId for efficient broadcasting
        const tabsByDevice = new Map<string, string[]>();
        dedupedTabs.forEach(({ deviceId, url }) => {
          if (!tabsByDevice.has(deviceId)) {
            tabsByDevice.set(deviceId, []);
          }
          tabsByDevice.get(deviceId)!.push(url);
        });
        
        // Send per-device close commands
        tabsByDevice.forEach((urls, deviceId) => {
          const count = broadcastToStudents(sessionSchoolId, {
            type: 'remote-control',
            command: {
              type: 'close-tab',
              data: { specificUrls: urls },
            },
          }, undefined, [deviceId]);
          sentCount += count;
        });
        
        message = `Closed ${dedupedTabs.length} tab(s) on ${tabsByDevice.size} device(s)`;
      }
      // Old paradigm (backward compatibility with deprecation warning)
      else {
        console.warn('[DEPRECATED] close-tabs using specificUrls+targetDeviceIds is deprecated. Use tabsToClose instead.');
        
        sentCount = broadcastToStudents(sessionSchoolId, {
          type: 'remote-control',
          command: {
            type: 'close-tab',
            data: { closeAll, pattern, specificUrls, allowedDomains },
          },
        }, undefined, targetDeviceIds);
        
        const target = targetDeviceIds && targetDeviceIds.length > 0 
          ? `${sentCount} device(s)` 
          : "all connected devices";
        
        message = specificUrls && specificUrls.length > 0
          ? `Closed ${specificUrls.length} selected tab(s) on ${target}`
          : `Closed tabs on ${target}`;
      }
      
      res.json({ success: true, message });
    } catch (error) {
      console.error("Close tabs error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  // Lock Screens - Lock students to specific URL or current URL
  app.post("/api/remote/lock-screen", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { url, targetDeviceIds } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }
      
      // Send "CURRENT_URL" to extension to lock to whatever student is currently viewing
      broadcastToStudents(sessionSchoolId, {
        type: 'remote-control',
        command: {
          type: 'lock-screen',
          data: { url },
        },
      }, undefined, targetDeviceIds);
      
      // Immediately update StudentStatus for instant UI feedback
      const deviceIdsToUpdate = targetDeviceIds && targetDeviceIds.length > 0 
        ? targetDeviceIds 
        : (await storage.getDevicesBySchool(sessionSchoolId)).map(d => d.deviceId);
      
      const now = Date.now();
      const lockedStudentIds = new Set<string>();
      for (const deviceId of deviceIdsToUpdate) {
        // Try to get active student, fall back to all students for this device
        const activeStudent = await storage.getActiveStudentForDevice(deviceId);
        const studentsToUpdate = activeStudent 
          ? [activeStudent]
          : await storage.getStudentsByDevice(sessionSchoolId, deviceId);
        
        for (const student of studentsToUpdate) {
          lockedStudentIds.add(student.id);
          let status = await storage.getStudentStatus(student.id);
          
          // Create status if it doesn't exist (e.g., student is offline)
          if (!status) {
            const device = await storage.getDevice(deviceId);
            status = {
              studentId: student.id,
              deviceId: deviceId,
              deviceName: device?.deviceName ?? undefined,
              studentName: student.studentName,
              classId: device?.classId ?? '',
              gradeLevel: student.gradeLevel ?? undefined,
              activeTabTitle: '',
              activeTabUrl: '',
              lastSeenAt: 0, // Will mark as offline
              screenLocked: false,
              isSharing: false,
              flightPathActive: false,
              cameraActive: false,
              status: 'offline',
            };
            await storage.updateStudentStatus(status);
          }
          
          status.screenLocked = true;
          status.screenLockedSetAt = now; // Prevent heartbeat overwrite for 5 seconds
          await storage.updateStudentStatus(status);
        }
      }
      
      // Notify teachers to update UI immediately
      broadcastToTeachers(sessionSchoolId, {
        type: 'student-update',
      });
      
      const target = targetDeviceIds && targetDeviceIds.length > 0 
        ? `${lockedStudentIds.size} student(s)` 
        : "all students";
      res.json({ success: true, message: `Locked ${target} to ${url}` });
    } catch (error) {
      console.error("Lock screen error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  // Unlock Screens
  app.post("/api/remote/unlock-screen", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { targetDeviceIds } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      broadcastToStudents(sessionSchoolId, {
        type: 'remote-control',
        command: {
          type: 'unlock-screen',
          data: {},
        },
      }, undefined, targetDeviceIds);
      
      // Immediately update StudentStatus for instant UI feedback
      const deviceIdsToUpdate = targetDeviceIds && targetDeviceIds.length > 0 
        ? targetDeviceIds 
        : (await storage.getDevicesBySchool(sessionSchoolId)).map(d => d.deviceId);
      
      const now = Date.now();
      const unlockedStudentIds = new Set<string>();
      for (const deviceId of deviceIdsToUpdate) {
        // Try to get active student, fall back to all students for this device
        const activeStudent = await storage.getActiveStudentForDevice(deviceId);
        const studentsToUpdate = activeStudent 
          ? [activeStudent]
          : await storage.getStudentsByDevice(sessionSchoolId, deviceId);
        
        for (const student of studentsToUpdate) {
          unlockedStudentIds.add(student.id);
          let status = await storage.getStudentStatus(student.id);
          
          // Create status if it doesn't exist (e.g., student is offline)
          if (!status) {
            const device = await storage.getDevice(deviceId);
            status = {
              studentId: student.id,
              deviceId: deviceId,
              deviceName: device?.deviceName ?? undefined,
              studentName: student.studentName,
              classId: device?.classId ?? '',
              gradeLevel: student.gradeLevel ?? undefined,
              activeTabTitle: '',
              activeTabUrl: '',
              lastSeenAt: 0, // Will mark as offline
              screenLocked: false,
              isSharing: false,
              flightPathActive: false,
              cameraActive: false,
              status: 'offline',
            };
            await storage.updateStudentStatus(status);
          }
          
          status.screenLocked = false;
          status.screenLockedSetAt = now; // Prevent heartbeat overwrite for 5 seconds
          await storage.updateStudentStatus(status);
        }
      }
      
      // Notify teachers to update UI immediately
      broadcastToTeachers(sessionSchoolId, {
        type: 'student-update',
      });
      
      const target = targetDeviceIds && targetDeviceIds.length > 0
        ? `${unlockedStudentIds.size} student(s)`
        : "all students";
      res.json({ success: true, message: `Unlocked ${target}` });
    } catch (error) {
      console.error("Unlock screen error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Temporary Unblock - Allow access to a specific domain for a limited time
  // In-memory store for temporary unblocks (expires automatically)
  const tempUnblocks = new Map<string, { domain: string; expiresAt: number }[]>();

  app.post("/api/remote/temp-unblock", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { domain, durationMinutes = 5, targetDeviceIds } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      if (!domain) {
        return res.status(400).json({ error: "Domain is required" });
      }

      const duration = Math.min(Math.max(parseInt(durationMinutes) || 5, 1), 60); // 1-60 minutes
      const expiresAt = Date.now() + (duration * 60 * 1000);

      // Broadcast temp unblock to students
      broadcastToStudents(sessionSchoolId, {
        type: 'remote-control',
        command: {
          type: 'temp-unblock',
          data: {
            domain,
            durationMinutes: duration,
            expiresAt,
          },
        },
      }, undefined, targetDeviceIds);

      const target = targetDeviceIds && targetDeviceIds.length > 0
        ? `${targetDeviceIds.length} device(s)`
        : "all students";
      res.json({ success: true, message: `Temporarily unblocked ${domain} for ${target} (${duration} minutes)` });
    } catch (error) {
      console.error("Temp unblock error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Apply Flight Path
  app.post("/api/remote/apply-flight-path", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { flightPathId, allowedDomains, targetDeviceIds } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      if (!flightPathId || !allowedDomains || !Array.isArray(allowedDomains)) {
        return res.status(400).json({ error: "Flight Path ID and allowed domains are required" });
      }
      
      // Fetch flight path details to get the flight path name
      const flightPath = await storage.getFlightPath(flightPathId);
      const flightPathName = flightPath?.flightPathName || 'Unknown Flight Path';
      if (!flightPath) {
        return res.status(404).json({ error: "Flight Path not found" });
      }
      if (!assertSameSchool(sessionSchoolId, flightPath.schoolId)) {
        return res.status(404).json({ error: "Flight Path not found" });
      }
      
      const sentCount = broadcastToStudents(sessionSchoolId, {
        type: 'remote-control',
        command: {
          type: 'apply-flight-path',
          data: {
            flightPathId,
            flightPathName,
            allowedDomains
          },
        },
      }, undefined, targetDeviceIds);

      // Immediately update StudentStatus for instant UI feedback (same as remove-flight-path)
      const now = Date.now();
      const deviceIds = targetDeviceIds && targetDeviceIds.length > 0
        ? targetDeviceIds
        : await (async () => {
            // If no specific devices, get all online devices for this school
            const students = await storage.getStudentStatusesBySchool(sessionSchoolId);
            return students
              .filter((s: StudentStatus) => s.status === 'online' || s.status === 'idle')
              .map((s: StudentStatus) => s.deviceId)
              .filter((id): id is string => !!id);
          })();

      for (const deviceId of deviceIds) {
        // Store in Redis for multi-instance consistency
        const redisSuccess = await setFlightPathStatus(deviceId, {
          active: true,
          flightPathName,
          flightPathId,
          appliedAt: now,
        });
        console.log(`[Flight Path] Apply to ${deviceId}: Redis write ${redisSuccess ? 'success' : 'failed/in-memory only'}, name=${flightPathName}`);

        const activeStudent = await storage.getActiveStudentForDevice(deviceId);
        if (activeStudent && assertSameSchool(sessionSchoolId, activeStudent.schoolId)) {
          const status = await storage.getStudentStatus(activeStudent.id);
          if (status) {
            status.flightPathActive = true;
            status.activeFlightPathName = flightPathName;
            status.screenLockedSetAt = now; // Prevent heartbeat overwrite for 5 seconds
            await storage.updateStudentStatus(status);
          }
        }
      }

      // Notify teachers to update UI immediately
      broadcastToTeachers(sessionSchoolId, {
        type: 'student-update',
      });

      const target = targetDeviceIds && targetDeviceIds.length > 0
        ? `${sentCount} device(s)`
        : "all connected devices";
      res.json({ success: true, message: `Applied flight path "${flightPathName}" to ${target}` });
    } catch (error) {
      console.error("Apply flight path error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Remove Flight Path
  app.post("/api/remote/remove-flight-path", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { targetDeviceIds } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      if (!targetDeviceIds || !Array.isArray(targetDeviceIds) || targetDeviceIds.length === 0) {
        return res.status(400).json({ error: "Target device IDs are required" });
      }
      
      broadcastToStudents(sessionSchoolId, {
        type: 'remote-control',
        command: {
          type: 'remove-flight-path',
          data: {},
        },
      }, undefined, targetDeviceIds);
      
      // Immediately update StudentStatus for instant UI feedback
      const now = Date.now();
      const removedStudentIds = new Set<string>();
      for (const deviceId of targetDeviceIds) {
        // Remove from Redis for multi-instance consistency
        const redisSuccess = await setFlightPathStatus(deviceId, {
          active: false,
          appliedAt: now,
        });
        console.log(`[Flight Path] Remove from ${deviceId}: Redis delete ${redisSuccess ? 'success' : 'failed/in-memory only'}`);

        const activeStudent = await storage.getActiveStudentForDevice(deviceId);
        if (activeStudent) {
          if (!assertSameSchool(sessionSchoolId, activeStudent.schoolId)) {
            return res.status(404).json({ error: "Student not found" });
          }
          removedStudentIds.add(activeStudent.id);
          const status = await storage.getStudentStatus(activeStudent.id);
          if (status) {
            status.flightPathActive = false;
            status.activeFlightPathName = undefined;
            status.screenLockedSetAt = now; // Prevent heartbeat overwrite for 5 seconds
            await storage.updateStudentStatus(status);
          }
        }
      }

      // Notify teachers to update UI immediately
      broadcastToTeachers(sessionSchoolId, {
        type: 'student-update',
      });
      
      const target = `${removedStudentIds.size} student(s)`;
      res.json({ success: true, message: `Removed flight path from ${target}` });
    } catch (error) {
      console.error("Remove flight path error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  // Limit Tabs
  app.post("/api/remote/limit-tabs", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { maxTabs } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      broadcastToStudents(sessionSchoolId, {
        type: 'remote-control',
        command: {
          type: 'limit-tabs',
          data: { maxTabs },
        },
      });

      res.json({ success: true, message: `Set tab limit to ${maxTabs}` });
    } catch (error) {
      console.error("Limit tabs error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Attention Mode - force students to look up from screens
  app.post("/api/remote/attention-mode", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { active, message, targetDeviceIds } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      let sentTo = 0;

      if (targetDeviceIds && Array.isArray(targetDeviceIds) && targetDeviceIds.length > 0) {
        // Send to specific devices
        for (const deviceId of targetDeviceIds) {
          sendToDevice(sessionSchoolId, deviceId, {
            type: 'remote-control',
            command: {
              type: 'attention-mode',
              data: { active: !!active, message: message || 'Please look up!' },
            },
          });
          sentTo++;
        }
      } else {
        // Broadcast to all students
        sentTo = broadcastToStudents(sessionSchoolId, {
          type: 'remote-control',
          command: {
            type: 'attention-mode',
            data: { active: !!active, message: message || 'Please look up!' },
          },
        });
      }

      res.json({ success: true, sentTo, message: active ? 'Attention mode enabled' : 'Attention mode disabled' });
    } catch (error) {
      console.error("Attention mode error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Timer - display countdown timer on student screens
  app.post("/api/remote/timer", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { action, seconds, message, targetDeviceIds } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      if (!action || !['start', 'stop'].includes(action)) {
        return res.status(400).json({ error: "Action must be 'start' or 'stop'" });
      }

      if (action === 'start' && (!seconds || seconds <= 0)) {
        return res.status(400).json({ error: "Seconds must be a positive number" });
      }

      let sentTo = 0;

      if (targetDeviceIds && Array.isArray(targetDeviceIds) && targetDeviceIds.length > 0) {
        // Send to specific devices
        for (const deviceId of targetDeviceIds) {
          sendToDevice(sessionSchoolId, deviceId, {
            type: 'remote-control',
            command: {
              type: 'timer',
              data: { action, seconds, message: message || '' },
            },
          });
          sentTo++;
        }
      } else {
        // Broadcast to all students
        sentTo = broadcastToStudents(sessionSchoolId, {
          type: 'remote-control',
          command: {
            type: 'timer',
            data: { action, seconds, message: message || '' },
          },
        });
      }

      res.json({ success: true, sentTo, message: action === 'start' ? `Timer started: ${seconds}s` : 'Timer stopped' });
    } catch (error) {
      console.error("Timer error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Send Chat Message
  app.post("/api/chat/send", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { message, toDeviceId } = req.body;
      
      if (!req.session?.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;
      
      const user = await storage.getUser(req.session.userId);
      
      if (!message) {
        return res.status(400).json({ error: "Message is required" });
      }
      
      const chatMessage = {
        type: 'chat',
        message,
        fromName: user?.username || 'Teacher',
        timestamp: Date.now(),
      };
      
      if (toDeviceId) {
        const device = await storage.getDevice(toDeviceId);
        if (!device || !assertSameSchool(sessionSchoolId, device.schoolId)) {
          return res.status(404).json({ error: "Device not found" });
        }
        // Send to specific device
        sendToDevice(sessionSchoolId, toDeviceId, chatMessage);
      } else {
        // Broadcast to all
        broadcastToStudents(sessionSchoolId, chatMessage);
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Send chat error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  
  // Send Check-in Request
  app.post("/api/checkin/request", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { question, options } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      if (!question || !options || !Array.isArray(options)) {
        return res.status(400).json({ error: "Question and options are required" });
      }

      broadcastToStudents(sessionSchoolId, {
        type: 'check-in-request',
        question,
        options,
        timestamp: Date.now(),
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Send check-in error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ====================================
  // POLLS API
  // ====================================

  // Create a new poll
  app.post("/api/polls/create", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { question, options, targetDeviceIds } = req.body;
      const teacherId = req.session?.userId;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      if (!question || !options || !Array.isArray(options) || options.length < 2) {
        return res.status(400).json({ error: "Question and at least 2 options are required" });
      }

      // Get active session for this teacher
      const activeSession = await storage.getActiveSessionByTeacher(teacherId);
      if (!activeSession) {
        return res.status(400).json({ error: "No active session. Start a class session first." });
      }

      // Create the poll
      const poll = await storage.createPoll({
        sessionId: activeSession.id,
        teacherId,
        question,
        options,
      });

      // Broadcast poll to students
      let sentTo = 0;
      if (targetDeviceIds && Array.isArray(targetDeviceIds) && targetDeviceIds.length > 0) {
        for (const deviceId of targetDeviceIds) {
          sendToDevice(sessionSchoolId, deviceId, {
            type: 'remote-control',
            command: {
              type: 'poll',
              data: { action: 'start', pollId: poll.id, question, options },
            },
          });
          sentTo++;
        }
      } else {
        sentTo = broadcastToStudents(sessionSchoolId, {
          type: 'remote-control',
          command: {
            type: 'poll',
            data: { action: 'start', pollId: poll.id, question, options },
          },
        });
      }

      res.json({ success: true, poll, sentTo });
    } catch (error) {
      console.error("Create poll error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get poll results
  app.get("/api/polls/:pollId/results", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, apiLimiter, async (req, res) => {
    try {
      const { pollId } = req.params;

      const poll = await storage.getPoll(pollId);
      if (!poll) {
        return res.status(404).json({ error: "Poll not found" });
      }

      const results = await storage.getPollResults(pollId);
      const responses = await storage.getPollResponsesByPoll(pollId);

      res.json({
        poll,
        results,
        totalResponses: responses.length,
      });
    } catch (error) {
      console.error("Get poll results error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Submit poll response (from extension)
  app.post("/api/polls/:pollId/respond", checkIPAllowlist, apiLimiter, async (req, res) => {
    try {
      const { pollId } = req.params;
      const { deviceId, studentId, selectedOption } = req.body;

      if (typeof selectedOption !== 'number') {
        return res.status(400).json({ error: "Selected option is required" });
      }

      const poll = await storage.getPoll(pollId);
      if (!poll) {
        return res.status(404).json({ error: "Poll not found" });
      }

      if (!poll.isActive) {
        return res.status(400).json({ error: "Poll is closed" });
      }

      if (selectedOption < 0 || selectedOption >= poll.options.length) {
        return res.status(400).json({ error: "Invalid option index" });
      }

      // Check if student already responded
      const existingResponses = await storage.getPollResponsesByPoll(pollId);
      const alreadyResponded = existingResponses.some(r => r.studentId === studentId || r.deviceId === deviceId);
      if (alreadyResponded) {
        return res.status(400).json({ error: "Already responded to this poll" });
      }

      const response = await storage.createPollResponse({
        pollId,
        studentId: studentId || 'anonymous',
        deviceId: deviceId || null,
        selectedOption,
      });

      res.json({ success: true, response });
    } catch (error) {
      console.error("Poll respond error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Close a poll
  app.post("/api/polls/:pollId/close", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { pollId } = req.params;
      const { targetDeviceIds } = req.body;
      const sessionSchoolId = res.locals.schoolId ?? req.session.schoolId!;

      const poll = await storage.closePoll(pollId);
      if (!poll) {
        return res.status(404).json({ error: "Poll not found" });
      }

      // Broadcast close command to students
      let sentTo = 0;
      if (targetDeviceIds && Array.isArray(targetDeviceIds) && targetDeviceIds.length > 0) {
        for (const deviceId of targetDeviceIds) {
          sendToDevice(sessionSchoolId, deviceId, {
            type: 'remote-control',
            command: {
              type: 'poll',
              data: { action: 'close', pollId },
            },
          });
          sentTo++;
        }
      } else {
        sentTo = broadcastToStudents(sessionSchoolId, {
          type: 'remote-control',
          command: {
            type: 'poll',
            data: { action: 'close', pollId },
          },
        });
      }

      res.json({ success: true, poll, sentTo });
    } catch (error) {
      console.error("Close poll error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get polls for current session
  app.get("/api/polls", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const teacherId = req.session?.userId;

      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const activeSession = await storage.getActiveSessionByTeacher(teacherId);
      if (!activeSession) {
        return res.json({ polls: [] });
      }

      const sessionPolls = await storage.getPollsBySession(activeSession.id);
      res.json({ polls: sessionPolls });
    } catch (error) {
      console.error("Get polls error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ====================================
  // SUBGROUPS API
  // ====================================

  // Get subgroups for a group
  app.get("/api/groups/:groupId/subgroups", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, apiLimiter, async (req, res) => {
    try {
      const { groupId } = req.params;

      const group = await storage.getGroup(groupId);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }

      const groupSubgroups = await storage.getSubgroupsByGroup(groupId);
      res.json({ subgroups: groupSubgroups });
    } catch (error) {
      console.error("Get subgroups error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Create a subgroup
  app.post("/api/groups/:groupId/subgroups", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { groupId } = req.params;
      const { name, color } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }

      const group = await storage.getGroup(groupId);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }

      const subgroup = await storage.createSubgroup({
        groupId,
        name,
        color: color || null,
      });

      res.json({ success: true, subgroup });
    } catch (error) {
      console.error("Create subgroup error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Update a subgroup
  app.put("/api/subgroups/:subgroupId", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { subgroupId } = req.params;
      const { name, color } = req.body;

      const subgroup = await storage.updateSubgroup(subgroupId, { name, color });
      if (!subgroup) {
        return res.status(404).json({ error: "Subgroup not found" });
      }

      res.json({ success: true, subgroup });
    } catch (error) {
      console.error("Update subgroup error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Delete a subgroup
  app.delete("/api/subgroups/:subgroupId", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { subgroupId } = req.params;

      const deleted = await storage.deleteSubgroup(subgroupId);
      if (!deleted) {
        return res.status(404).json({ error: "Subgroup not found" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Delete subgroup error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get subgroup members
  app.get("/api/subgroups/:subgroupId/members", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, apiLimiter, async (req, res) => {
    try {
      const { subgroupId } = req.params;

      const members = await storage.getSubgroupMembers(subgroupId);
      res.json({ members });
    } catch (error) {
      console.error("Get subgroup members error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Add members to a subgroup
  app.post("/api/subgroups/:subgroupId/members", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { subgroupId } = req.params;
      const { studentIds } = req.body;

      if (!studentIds || !Array.isArray(studentIds)) {
        return res.status(400).json({ error: "Student IDs array is required" });
      }

      const subgroup = await storage.getSubgroup(subgroupId);
      if (!subgroup) {
        return res.status(404).json({ error: "Subgroup not found" });
      }

      const added = [];
      for (const studentId of studentIds) {
        try {
          const member = await storage.addSubgroupMember(subgroupId, studentId);
          added.push(member);
        } catch (err) {
          // Ignore duplicate errors
          console.log(`Could not add student ${studentId} to subgroup:`, err);
        }
      }

      res.json({ success: true, added: added.length });
    } catch (error) {
      console.error("Add subgroup members error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Remove a member from a subgroup
  app.delete("/api/subgroups/:subgroupId/members/:studentId", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { subgroupId, studentId } = req.params;

      const removed = await storage.removeSubgroupMember(subgroupId, studentId);
      if (!removed) {
        return res.status(404).json({ error: "Member not found" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Remove subgroup member error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ====================================
  // RAISE HAND API
  // ====================================

  // In-memory storage for raised hands (ephemeral, per session)
  const raisedHands = new Map<string, { studentId: string; studentName: string; studentEmail: string; deviceId: string; timestamp: Date; schoolId: string }>();

  // Student raises hand
  app.post("/api/student/raise-hand", requireDeviceAuth, requireActiveSchoolDeviceMiddleware, apiLimiter, async (req, res) => {
    try {
      const authSchoolId = res.locals.schoolId as string | undefined;
      const authStudentId = res.locals.studentId as string | undefined;
      const authDeviceId = res.locals.deviceId as string | undefined;

      if (!authSchoolId || !authDeviceId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      let { studentName, studentEmail } = req.body;

      // Look up the actual student record to get the correct name
      if (authStudentId) {
        const student = await storage.getStudent(authStudentId);
        if (student) {
          studentName = student.studentName || studentName;
          studentEmail = student.studentEmail || studentEmail;
        }
      }

      // Check if messaging/hand raising is enabled for this school
      const settings = await storage.getSettingsBySchoolId(authSchoolId);
      if (settings?.handRaisingEnabled === false) {
        return res.status(403).json({ error: "Hand raising is disabled" });
      }

      const handKey = authStudentId || authDeviceId;
      raisedHands.set(handKey, {
        studentId: authStudentId || authDeviceId,
        studentName: studentName || "Unknown Student",
        studentEmail: studentEmail || "",
        deviceId: authDeviceId,
        timestamp: new Date(),
        schoolId: authSchoolId,
      });

      // Broadcast to teachers
      broadcastToTeachers(authSchoolId, {
        type: "hand-raised",
        data: {
          studentId: authStudentId || authDeviceId,
          studentName: studentName || "Unknown Student",
          studentEmail: studentEmail || "",
          deviceId: authDeviceId,
          timestamp: new Date().toISOString(),
        },
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Raise hand error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Student lowers hand
  app.post("/api/student/lower-hand", requireDeviceAuth, requireActiveSchoolDeviceMiddleware, apiLimiter, async (req, res) => {
    try {
      const authSchoolId = res.locals.schoolId as string | undefined;
      const authStudentId = res.locals.studentId as string | undefined;
      const authDeviceId = res.locals.deviceId as string | undefined;

      if (!authSchoolId || !authDeviceId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const handKey = authStudentId || authDeviceId;
      raisedHands.delete(handKey);

      // Broadcast to teachers
      broadcastToTeachers(authSchoolId, {
        type: "hand-lowered",
        data: {
          studentId: authStudentId || authDeviceId,
          deviceId: authDeviceId,
        },
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Lower hand error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Teacher dismisses a raised hand
  app.post("/api/teacher/dismiss-hand/:studentId", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { studentId } = req.params;
      const schoolId = req.session?.schoolId;

      if (!schoolId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      raisedHands.delete(studentId);

      // Notify the student that their hand was dismissed
      const student = await storage.getStudent(studentId);
      if (student?.deviceId) {
        sendToDevice(schoolId, student.deviceId, {
          type: "remote-control",
          command: {
            type: "hand-dismissed",
          },
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Dismiss hand error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all raised hands for the current school
  app.get("/api/teacher/raised-hands", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const schoolId = req.session?.schoolId;

      if (!schoolId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const hands = Array.from(raisedHands.entries())
        .filter(([_, hand]) => hand.schoolId === schoolId)
        .map(([key, hand]) => ({
          id: key,
          studentId: hand.studentId,
          studentName: hand.studentName,
          studentEmail: hand.studentEmail,
          deviceId: hand.deviceId,
          timestamp: hand.timestamp.toISOString(),
        }));

      res.json({ raisedHands: hands });
    } catch (error) {
      console.error("Get raised hands error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Toggle hand raising for the school
  app.post("/api/settings/hand-raising", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const schoolId = req.session?.schoolId;
      const { enabled } = req.body;

      if (!schoolId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Update the settings
      await storage.upsertSettingsForSchool(schoolId, { handRaisingEnabled: enabled });

      // Broadcast to all students in this school
      broadcastToStudents(schoolId, {
        type: "remote-control",
        command: {
          type: "hand-raising-toggle",
          data: { enabled },
        },
      });

      res.json({ success: true, enabled });
    } catch (error) {
      console.error("Toggle hand raising error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Toggle student messaging for the school
  app.post("/api/settings/student-messaging", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const schoolId = req.session?.schoolId;
      const { enabled } = req.body;

      if (!schoolId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Update the settings
      await storage.upsertSettingsForSchool(schoolId, { studentMessagingEnabled: enabled });

      // Broadcast to all students in this school
      broadcastToStudents(schoolId, {
        type: "remote-control",
        command: {
          type: "messaging-toggle",
          data: { messagingEnabled: enabled },
        },
      });

      res.json({ success: true, enabled });
    } catch (error) {
      console.error("Toggle student messaging error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============================================
  // TWO-WAY CHAT ENDPOINTS
  // ============================================

  // Student sends a message to teacher
  app.post("/api/student/send-message", requireDeviceAuth, requireActiveSchoolDeviceMiddleware, apiLimiter, async (req, res) => {
    try {
      const authSchoolId = res.locals.schoolId;
      const authStudentId = res.locals.studentId;
      const authDeviceId = res.locals.deviceId;
      const { message, messageType = 'message' } = req.body;

      if (!authStudentId) {
        return res.status(401).json({ error: "Student not identified" });
      }

      // Check if messaging is enabled for this school
      const settings = await storage.getSettingsBySchoolId(authSchoolId);
      if (settings?.studentMessagingEnabled === false) {
        return res.status(403).json({ error: "Student messaging is disabled" });
      }

      // Validate message
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: "Message is required" });
      }
      if (message.length > 500) {
        return res.status(400).json({ error: "Message too long (max 500 characters)" });
      }

      // Get student info
      const student = await storage.getStudent(authStudentId);
      if (!student) {
        return res.status(404).json({ error: "Student not found" });
      }

      // Store in chatMessages table
      const chatMessage = await storage.createChatMessage({
        sessionId: 'direct', // Direct messages not tied to a specific session
        senderId: authStudentId,
        senderType: 'student',
        recipientId: null, // Goes to all teachers in the school
        content: message.trim(),
        messageType: messageType as 'message' | 'question',
      });

      // Broadcast to all teachers in this school
      broadcastToTeachers(authSchoolId, {
        type: 'student-message',
        data: {
          messageId: chatMessage.id,
          studentId: authStudentId,
          studentName: student.studentName,
          studentEmail: student.studentEmail,
          deviceId: authDeviceId,
          message: message.trim(),
          messageType,
          timestamp: new Date().toISOString(),
        }
      });

      console.log(`[Chat] Student ${student.studentEmail} sent message: "${message.slice(0, 50)}..."`);
      res.json({ success: true, messageId: chatMessage.id });
    } catch (error) {
      console.error("Student send message error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Teacher gets recent student messages
  app.get("/api/teacher/messages", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId;
      const { since, limit = '50' } = req.query;

      if (!sessionSchoolId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const messages = await storage.getStudentMessagesForSchool(sessionSchoolId, {
        since: since ? new Date(since as string) : undefined,
        limit: parseInt(limit as string, 10),
      });

      // Enrich messages with student info
      const enrichedMessages = await Promise.all(messages.map(async (msg) => {
        const student = await storage.getStudent(msg.senderId);
        return {
          id: msg.id,
          studentId: msg.senderId,
          studentName: student?.studentName || 'Unknown',
          studentEmail: student?.studentEmail || 'unknown',
          message: msg.content,
          messageType: msg.messageType,
          timestamp: msg.createdAt,
        };
      }));

      res.json({ messages: enrichedMessages });
    } catch (error) {
      console.error("Get teacher messages error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Teacher replies to a specific student
  app.post("/api/teacher/reply", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const sessionSchoolId = res.locals.schoolId;
      const teacherId = req.session?.userId;
      const { studentId, message } = req.body;

      if (!sessionSchoolId || !teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Get teacher info for the reply
      const teachers = await storage.getUsersBySchool(sessionSchoolId);
      const teacher = teachers.find(t => t.id === teacherId);
      const teacherName = teacher?.displayName || teacher?.email || 'Teacher';

      if (!studentId || !message) {
        return res.status(400).json({ error: "studentId and message are required" });
      }

      if (message.length > 500) {
        return res.status(400).json({ error: "Message too long (max 500 characters)" });
      }

      const student = await storage.getStudent(studentId);
      if (!student || student.schoolId !== sessionSchoolId) {
        return res.status(404).json({ error: "Student not found" });
      }

      // Store the reply
      const chatMessage = await storage.createChatMessage({
        sessionId: 'direct',
        senderId: teacherId,
        senderType: 'teacher',
        recipientId: studentId,
        content: message.trim(),
        messageType: 'message',
      });

      // Send to the specific student's device
      if (student.deviceId) {
        sendToDevice(sessionSchoolId, student.deviceId, {
          type: 'chat',
          message: message.trim(),
          fromName: teacherName,
          timestamp: Date.now(),
        });
      }

      console.log(`[Chat] Teacher replied to ${student.studentEmail}: "${message.slice(0, 50)}..."`);
      res.json({ success: true, messageId: chatMessage.id });
    } catch (error) {
      console.error("Teacher reply error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Teacher dismisses/deletes a student message
  app.delete("/api/teacher/messages/:messageId", checkIPAllowlist, requireAuth, requireSchoolContext, requireActiveSchoolMiddleware, requireTeacherRole, apiLimiter, async (req, res) => {
    try {
      const { messageId } = req.params;

      if (!messageId) {
        return res.status(400).json({ error: "Message ID is required" });
      }

      const deleted = await storage.deleteChatMessage(messageId);

      if (!deleted) {
        return res.status(404).json({ error: "Message not found" });
      }

      console.log(`[Chat] Teacher deleted message: ${messageId}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete message error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  if (enableBackgroundJobs) {
    // Session expiration job (runs frequently for real-time accuracy)
    setInterval(async () => {
      try {
        // Expire stale student sessions (not seen in 90 seconds)
        const expiredSessions = await storage.expireStaleStudentSessions(90);
        if (expiredSessions > 0) {
          console.log(`[Session Cleanup] Expired ${expiredSessions} stale student sessions`);
          // Notify teachers to update UI after session expiration
          const schools = await storage.getAllSchools(true);
          schools.forEach((school) => {
            broadcastToTeachers(school.id, {
              type: 'student-update',
            });
          });
        }
      } catch (error) {
        console.error("[Session Cleanup] Error:", error);
      }
    }, 60 * 1000); // Run every minute for real-time monitoring

    // Data cleanup cron (run periodically for old data)
    setInterval(async () => {
      try {
        // Clean up old heartbeats based on retention settings
        const schools = await storage.getAllSchools(true);
        let retentionHours = 24;
        for (const school of schools) {
          const settings = await storage.getSettingsBySchoolId(school.id);
          const parsedRetention = parseInt(settings?.retentionHours || "24");
          if (!Number.isNaN(parsedRetention)) {
            retentionHours = Math.max(retentionHours, parsedRetention);
          }
        }
        const deleted = await storage.cleanupOldHeartbeats(retentionHours);
        if (deleted > 0) {
          console.log(`[Data Cleanup] Cleaned up ${deleted} old heartbeats`);
        }
      } catch (error) {
        console.error("[Data Cleanup] Error:", error);
      }
    }, 60 * 60 * 1000); // Run every hour
  }

  return httpServer;
}

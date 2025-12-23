import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "@neondatabase/serverless";
import cors from "cors";
import passport from "passport";
import * as Sentry from "@sentry/node";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { initializeApp } from "./init";
import { setupGoogleAuth } from "./googleAuth";
import { getRequiredSecret } from "./util/env";

const SENTRY_DSN_SERVER = process.env.SENTRY_DSN_SERVER;
const SENTRY_SENSITIVE_KEY_REGEX = /(email|student|name)/i;
const SENTRY_URL_KEY_REGEX = /url/i;
const SENTRY_EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const SENTRY_URL_REGEX = /https?:\/\/\S+/i;

function sanitizeSentryUrl(value: string) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (error) {
    const withoutQuery = value.split("?")[0];
    if (withoutQuery && withoutQuery !== value) {
      return withoutQuery;
    }
    return "[redacted]";
  }
}

function scrubSentryString(value: string, key?: string) {
  if (SENTRY_EMAIL_REGEX.test(value)) {
    return "[redacted]";
  }
  if (SENTRY_URL_REGEX.test(value)) {
    return sanitizeSentryUrl(value);
  }
  if (key && SENTRY_SENSITIVE_KEY_REGEX.test(key)) {
    return "[redacted]";
  }
  if (key && SENTRY_URL_KEY_REGEX.test(key)) {
    return sanitizeSentryUrl(value);
  }
  return value;
}

function scrubSentryData(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return scrubSentryString(value, key);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubSentryData(item, key));
  }
  if (value && typeof value === "object") {
    const cleaned: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      cleaned[childKey] = scrubSentryData(childValue, childKey);
    }
    return cleaned;
  }
  return value;
}

if (SENTRY_DSN_SERVER) {
  Sentry.init({
    dsn: SENTRY_DSN_SERVER,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request?.url) {
        event.request.url = sanitizeSentryUrl(event.request.url);
      }
      if (event.request) {
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.query_string;
      }
      if (event.extra) {
        event.extra = scrubSentryData(event.extra) as Record<string, unknown>;
      }
      if (event.tags) {
        event.tags = scrubSentryData(event.tags) as Record<string, string>;
      }
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.map((crumb) => ({
          ...crumb,
          message: crumb.message ? scrubSentryString(crumb.message, "message") : crumb.message,
          data: crumb.data ? scrubSentryData(crumb.data) : crumb.data,
        }));
      }
      return event;
    },
  });
}

// Global error handlers to prevent process crashes
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  if (SENTRY_DSN_SERVER) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    Sentry.captureException(error);
  }
  // Don't exit - log and continue
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  if (SENTRY_DSN_SERVER) {
    Sentry.captureException(error);
  }
  // Don't exit - log and continue (consider graceful shutdown in production)
});

const app = express();

// CRITICAL: Trust proxy for Replit Deployments
app.set('trust proxy', 1);

// Sentry v8: Express request handling is automatic via init()

// CORS configuration for chrome-extension and cross-origin requests
const allowlist = (process.env.CORS_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // In development mode, allow all origins
    if (process.env.NODE_ENV === 'development') {
      return cb(null, true);
    }
    
    // Allow same-origin requests (no origin header)
    if (!origin) return cb(null, true);
    
    // Allow chrome-extension origins
    if (origin.startsWith('chrome-extension://')) return cb(null, true);
    
    // Allow configured allowlist
    if (allowlist.some(a => origin === a || (a.endsWith('/*') && origin.startsWith(a.slice(0, -1))))) {
      return cb(null, true);
    }
    
    // Allow replit.app domains in production
    if (origin.includes('.replit.app') || origin.includes('.replit.dev')) {
      return cb(null, true);
    }
    
    // Reject others
    cb(new Error('CORS blocked'));
  },
  credentials: true, // Allow cookies to be sent
}));

// Session store configuration
const PgStore = connectPgSimple(session);
const sessionStore = process.env.DATABASE_URL 
  ? new PgStore({
      pool: new Pool({ connectionString: process.env.DATABASE_URL }),
      createTableIfMissing: true,
    })
  : undefined; // Use default MemoryStore in development if no DATABASE_URL

// Session configuration
const sessionSecret = getRequiredSecret("SESSION_SECRET", {
  minBytes: 32,
  devLogMessage: "[auth] Generated dev SESSION_SECRET",
});

export const sessionMiddleware = session({
  name: 'classpilot_session',
  store: sessionStore,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true, // Auto-renew session on activity to keep it alive
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production", // true for HTTPS
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", // 'none' allows chrome-extension
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
});

app.use(sessionMiddleware);

// Setup Google OAuth (must be after session middleware)
setupGoogleAuth(app);

// Extend session type
declare module "express-session" {
  interface SessionData {
    userId: string;
    role: string;
    schoolId?: string;
    impersonating?: boolean;
    originalUserId?: string;
  }
}

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}
// Parse JSON with size limit to prevent memory issues
app.use(express.json({
  limit: '12kb', // Prevent large payload attacks
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false, limit: '12kb' }));

// Client runtime config endpoint (for dynamic URLs)
app.get('/client-config.json', (req, res) => {
  res.json({
    baseUrl: process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`,
    schoolId: process.env.SCHOOL_ID || 'default-school',
    wsAvailable: !!process.env.WS_SHARED_KEY,
  });
});

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

if (process.env.NODE_ENV !== "production") {
  app.get("/api/dev/throw", (_req, _res) => {
    throw new Error("Sentry dev test error");
  });
}

(async () => {
  // Initialize default data
  try {
    await initializeApp();
  } catch (error) {
    if (SENTRY_DSN_SERVER) {
      Sentry.captureException(error);
    }
    throw error;
  }
  
  const server = await registerRoutes(app);

  if (SENTRY_DSN_SERVER) {
    Sentry.setupExpressErrorHandler(app);
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const safeMessage = status >= 500 ? "Internal Server Error" : err.message || "Request failed";

    res.status(status).json({ message: safeMessage });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
})();

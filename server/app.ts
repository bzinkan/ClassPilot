import express, { type Request, Response, NextFunction } from "express";
import session, { type SessionOptions } from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
const { Pool: PgPool } = pg;
import cors from "cors";
import helmet from "helmet";
import csurf from "csurf";
import * as Sentry from "@sentry/node";
import { registerRoutes } from "./routes";
import { setupGoogleAuth } from "./googleAuth";
import { getRequiredSecret, isProduction } from "./util/env";
import { buildClientConfig } from "./config/clientConfig";
import { type IStorage, storage as defaultStorage } from "./storage";

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
        event.breadcrumbs = event.breadcrumbs.map((crumb) => {
          const scrubbed = crumb.data ? scrubSentryData(crumb.data) : undefined;

          const safeData =
            scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed)
              ? (scrubbed as Record<string, unknown>)
              : undefined;

          return {
            ...crumb,
            message: crumb.message ? scrubSentryString(crumb.message, "message") : crumb.message,
            data: safeData,
          };
        });
      }
      return event;
    },
  });
}

// Global error handlers to prevent process crashes
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
  if (SENTRY_DSN_SERVER) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    Sentry.captureException(error);
  }
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  if (SENTRY_DSN_SERVER) {
    Sentry.captureException(error);
  }
});

export interface AppOptions {
  storage?: IStorage;
  enableBackgroundJobs?: boolean;
}

export async function createApp(options: AppOptions = {}) {
  const app = express();

  // Trust proxy for reverse proxy / load balancer deployments (AWS ALB, nginx, etc.)
  if (isProduction()) {
    app.set("trust proxy", 1);
  }

  app.use(
    helmet({
      frameguard: { action: "sameorigin" },
      noSniff: true,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      // Only enable HSTS when using HTTPS (check PUBLIC_BASE_URL or default to false for HTTP load balancers)
      hsts: process.env.PUBLIC_BASE_URL?.startsWith('https://') ? {
            maxAge: 15552000,
            includeSubDomains: true,
          }
        : false,
      contentSecurityPolicy: isProduction() ? {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          frameAncestors: ["'self'"],
          objectSrc: ["'none'"],
          imgSrc: ["'self'", "data:", "https:", "http:"],
          fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'", "https:", "http:", "wss:", "ws:"],
          // Only upgrade insecure requests when PUBLIC_BASE_URL is HTTPS
          ...(process.env.PUBLIC_BASE_URL?.startsWith('https://') ? { upgradeInsecureRequests: [] } : {}),
        },
      } : false,
    })
  );

  // CORS configuration for chrome-extension and cross-origin requests
  const allowlist = (process.env.CORS_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin(origin, cb) {
        // In development mode, allow all origins
        if (process.env.NODE_ENV === "development") {
          return cb(null, true);
        }

        // Allow same-origin requests (no origin header)
        if (!origin) return cb(null, true);

        // Allow chrome-extension origins
        if (origin.startsWith("chrome-extension://")) return cb(null, true);

        // Allow configured allowlist
        if (allowlist.some((a) => origin === a || (a.endsWith("/*") && origin.startsWith(a.slice(0, -1))))) {
          return cb(null, true);
        }

        // Allow AWS ALB domains (for Fargate deployments)
        if (origin.includes(".elb.amazonaws.com")) {
          return cb(null, true);
        }

        // Allow custom domain from PUBLIC_BASE_URL (both www and non-www)
        const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim();
        if (publicBaseUrl) {
          try {
            const customDomain = new URL(publicBaseUrl).hostname;
            // Strip www. prefix to get base domain for comparison
            const baseDomain = customDomain.replace(/^www\./, '');
            // Allow both www.domain.com and domain.com
            if (origin.includes(baseDomain)) {
              return cb(null, true);
            }
          } catch (e) {
            // Invalid URL, skip
          }
        }

        // Reject others
        cb(new Error("CORS blocked"));
      },
      credentials: true, // Allow cookies to be sent
    })
  );

  // Session store configuration
  const useMemoryStore = process.env.NODE_ENV === "test";
  const PgStore = connectPgSimple(session);
  if (isProduction()) {
    getRequiredSecret("DATABASE_URL", { minBytes: 1 });
  }
  const sessionPool = useMemoryStore
    ? undefined
    : new PgPool({
        connectionString: process.env.DATABASE_URL,
      });
  if (sessionPool && process.env.NODE_ENV !== "test") {
    try {
      await sessionPool.query("SELECT 1");
      console.log("[db] session store connectivity ok");
    } catch (error) {
      console.error("[db] session store connectivity failed", error);
      throw error;
    }
  }

  const sessionStore = useMemoryStore
    ? new session.MemoryStore()
    : new PgStore({
        pool: sessionPool,
        createTableIfMissing: true,
      });

  // Session configuration
  const sessionSecret = getRequiredSecret("SESSION_SECRET", {
    minBytes: 32,
    devLogMessage: "[auth] Generated dev SESSION_SECRET",
  });

  const sessionOptions = {
    name: "classpilot.sid",
    store: sessionStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true, // Auto-renew session on activity to keep it alive
    cookie: {
      httpOnly: true,
      secure: isProduction(), // true for HTTPS
      sameSite: "lax",
      maxAge: 12 * 60 * 60 * 1000, // 12 hours
    },
  } satisfies SessionOptions;

  const sessionMiddleware = session(sessionOptions);

  app.set("session-cookie-options", sessionOptions.cookie);

  app.use(sessionMiddleware);

  if (isProduction()) {
    console.log("prod session: trustProxy=1 secureCookie=true store=pg");
  }

  // Setup Google OAuth (must be after session middleware)
  setupGoogleAuth(app);

  // Screenshot endpoint needs larger body limit (500KB for compressed images)
  // Must be defined BEFORE the general JSON parser
  app.use("/api/device/screenshot", express.json({ limit: "500kb" }));

  // Parse JSON with size limit to prevent memory issues
  app.use(
    express.json({
      limit: "12kb", // Prevent large payload attacks
      verify: (req, _res, buf) => {
        // rawBody is declared via server/types/express.d.ts
        req.rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: false, limit: "12kb" }));

  const csrfProtection = csurf();
  const csrfExcludedPaths = new Set(["/api/login"]);
  const isMutatingMethod = (method: string) => !["GET", "HEAD", "OPTIONS"].includes(method);

  app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) {
      return next();
    }
    if (!isMutatingMethod(req.method)) {
      return next();
    }
    if (!req.session?.userId) {
      return next();
    }
    if (csrfExcludedPaths.has(req.path)) {
      return next();
    }
    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      return next();
    }
    return csrfProtection(req, res, next);
  });

  // Health check endpoint with database connectivity test
  let lastHealthCheck = { ok: true, database: "unknown", timestamp: Date.now() };
  let healthCheckCache = lastHealthCheck;
  const HEALTH_CHECK_CACHE_MS = 10000; // Cache for 10 seconds

  app.get("/health", async (_req, res) => {
    const now = Date.now();

    // Return cached result if fresh
    if (now - healthCheckCache.timestamp < HEALTH_CHECK_CACHE_MS) {
      return res.status(healthCheckCache.ok ? 200 : 503).json(healthCheckCache);
    }

    // Perform actual health check
    let dbStatus = "unknown";
    let isHealthy = true;

    if (sessionPool) {
      try {
        await sessionPool.query("SELECT 1");
        dbStatus = "connected";
      } catch (error) {
        console.error("[health] Database check failed:", error);
        dbStatus = "disconnected";
        isHealthy = false;
      }
    } else {
      dbStatus = "memory-store"; // Using in-memory session store (test mode)
    }

    healthCheckCache = {
      ok: isHealthy,
      database: dbStatus,
      timestamp: now
    };

    res.status(isHealthy ? 200 : 503).json(healthCheckCache);
  });

  app.get("/client-config.json", (req, res) => {
    res.json(buildClientConfig(req));
  });

  app.get("/api/client-config", (req, res) => {
    res.json(buildClientConfig(req));
  });

  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;

    res.on("finish", () => {
      const duration = Date.now() - start;
      if (path.startsWith("/api")) {
        const method = req.method;
        console.log(`${method} ${path} ${res.statusCode} in ${duration}ms`);
      }
    });

    next();
  });

  if (process.env.NODE_ENV !== "production") {
    app.get("/api/dev/throw", (_req, _res) => {
      throw new Error("Sentry dev test error");
    });
  }

  app.get("/api/csrf", csrfProtection, (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
  });

  const server = await registerRoutes(app, {
    storage: options.storage ?? defaultStorage,
    sessionMiddleware,
    enableBackgroundJobs: options.enableBackgroundJobs,
  });

  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (err?.code === "EBADCSRFTOKEN") {
      const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined;
      const csrfMetadata = {
        method: req.method,
        path: req.originalUrl.split("?")[0],
        userId: req.session?.userId,
        schoolId: req.session?.schoolId,
        ip: req.ip,
        userAgent: userAgent ? userAgent.slice(0, 200) : undefined,
      };

      console.warn("[security] Invalid CSRF token", csrfMetadata);
      if (SENTRY_DSN_SERVER) {
        Sentry.withScope((scope) => {
          scope.setLevel("warning");
          scope.setExtras(csrfMetadata);
          Sentry.captureMessage("Invalid CSRF token");
        });
      }
      return res.status(403).json({ error: "Invalid CSRF token" });
    }
    return next(err);
  });

  if (SENTRY_DSN_SERVER) {
    Sentry.setupExpressErrorHandler(app);
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      return _next(err);
    }
    const status = err.status || err.statusCode || 500;
    const safeMessage = status >= 500 ? "Internal Server Error" : err.message || "Request failed";

    console.error(`[error-handler] ${_req.method} ${_req.path} - ${status}: ${err.message || err}`);
    res.status(status).json({ message: safeMessage });
  });

  return { app, server };
}

import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "@neondatabase/serverless";
import cors from "cors";
import helmet from "helmet";
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

  // CRITICAL: Trust proxy for Replit Deployments
  app.set("trust proxy", 1);

  app.use(
    helmet({
      frameguard: { action: "sameorigin" },
      noSniff: true,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      hsts: isProduction()
        ? {
            maxAge: 15552000,
            includeSubDomains: true,
          }
        : false,
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          frameAncestors: ["'self'"],
          objectSrc: ["'none'"],
          imgSrc: ["'self'", "data:", "https:"],
          fontSrc: ["'self'", "data:", "https:"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'", "https:", "wss:"],
          upgradeInsecureRequests: isProduction() ? [] : null,
        },
      },
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

        // Allow replit.app domains in production
        if (origin.includes(".replit.app") || origin.includes(".replit.dev")) {
          return cb(null, true);
        }

        // Reject others
        cb(new Error("CORS blocked"));
      },
      credentials: true, // Allow cookies to be sent
    })
  );

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

  const sessionMiddleware = session({
    name: "classpilot_session",
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

  // Parse JSON with size limit to prevent memory issues
  app.use(
    express.json({
      limit: "12kb", // Prevent large payload attacks
      verify: (req, _res, buf) => {
        // rawBody is declared via server/types/global.d.ts
        req.rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: false, limit: "12kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
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

  const server = await registerRoutes(app, {
    storage: options.storage ?? defaultStorage,
    sessionMiddleware,
    enableBackgroundJobs: options.enableBackgroundJobs,
  });

  if (SENTRY_DSN_SERVER) {
    Sentry.setupExpressErrorHandler(app);
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const safeMessage = status >= 500 ? "Internal Server Error" : err.message || "Request failed";

    res.status(status).json({ message: safeMessage });
  });

  return { app, server };
}

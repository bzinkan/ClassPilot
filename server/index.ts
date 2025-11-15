import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "@neondatabase/serverless";
import cors from "cors";
import passport from "passport";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { initializeApp } from "./init";
import { setupGoogleAuth } from "./googleAuth";

// Global error handlers to prevent process crashes
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  // Don't exit - log and continue
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit - log and continue (consider graceful shutdown in production)
});

const app = express();

// CRITICAL: Trust proxy for Replit Deployments
app.set('trust proxy', 1);

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
app.use(
  session({
    name: 'classpilot_session',
    store: sessionStore,
    secret: process.env.SESSION_SECRET || "classroom-screen-awareness-secret",
    resave: false,
    saveUninitialized: false,
    rolling: true, // Auto-renew session on activity to keep it alive
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // true for HTTPS
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", // 'none' allows chrome-extension
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// Setup Google OAuth (must be after session middleware)
setupGoogleAuth(app);

// Extend session type
declare module "express-session" {
  interface SessionData {
    userId: string;
    role: string;
    schoolId?: string;
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
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Initialize default data
  await initializeApp();
  
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
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

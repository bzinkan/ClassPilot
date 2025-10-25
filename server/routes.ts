import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import bcrypt from "bcrypt";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  insertStudentSchema,
  insertHeartbeatSchema,
  insertEventSchema,
  insertRosterSchema,
  insertSettingsSchema,
  loginSchema,
  type StudentStatus,
  type SignalMessage,
} from "@shared/schema";

// Rate limiters
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
});

const heartbeatLimiter = rateLimit({
  windowMs: 10 * 1000, // 10 seconds
  max: 2, // 2 requests per 10 seconds (allows one heartbeat every 5 seconds)
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

// WebSocket clients
interface WSClient {
  ws: WebSocket;
  role: 'teacher' | 'student';
  deviceId?: string;
  authenticated: boolean;
}

const wsClients = new Map<WebSocket, WSClient>();

function broadcastToTeachers(message: any) {
  const messageStr = JSON.stringify(message);
  wsClients.forEach((client, ws) => {
    if (client.role === 'teacher' && client.authenticated && ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
    }
  });
}

// Session middleware
function requireAuth(req: any, res: any, next: any) {
  if (req.session?.userId) {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // WebSocket server on /ws path
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    const client: WSClient = {
      ws,
      role: 'student',
      authenticated: false,
    };
    wsClients.set(ws, client);

    console.log('WebSocket client connected');

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Handle authentication
        if (message.type === 'auth') {
          if (message.role === 'teacher') {
            // In production, validate WS_SHARED_KEY from settings
            client.role = 'teacher';
            client.authenticated = true;
            ws.send(JSON.stringify({ type: 'auth-success', role: 'teacher' }));
          } else if (message.role === 'student' && message.deviceId) {
            client.role = 'student';
            client.deviceId = message.deviceId;
            client.authenticated = true;
            ws.send(JSON.stringify({ type: 'auth-success', role: 'student' }));
          }
        }

        // Handle WebRTC signaling
        if (message.type === 'signal' && client.authenticated) {
          const signal: SignalMessage = message.data;
          // Forward signal to appropriate recipient
          wsClients.forEach((otherClient, otherWs) => {
            if (otherClient.deviceId === signal.deviceId && otherWs !== ws && otherWs.readyState === WebSocket.OPEN) {
              otherWs.send(JSON.stringify({ type: 'signal', data: signal }));
            }
          });
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    ws.on('close', () => {
      wsClients.delete(ws);
      console.log('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      wsClients.delete(ws);
    });
  });

  // Authentication endpoints
  app.post("/api/login", async (req, res) => {
    try {
      const { username, password } = loginSchema.parse(req.body);
      const user = await storage.getUserByUsername(username);

      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      req.session.userId = user.id;
      res.json({ success: true, user: { id: user.id, username: user.username } });
    } catch (error) {
      console.error("Login error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  // Student registration (from extension)
  app.post("/api/register", apiLimiter, async (req, res) => {
    try {
      const data = insertStudentSchema.parse(req.body);
      
      // Check if student already exists
      const existing = await storage.getStudent(data.deviceId);
      if (existing) {
        return res.json({ success: true, student: existing });
      }

      const student = await storage.registerStudent(data);
      
      // Notify teachers
      broadcastToTeachers({
        type: 'student-registered',
        data: student,
      });

      res.json({ success: true, student });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Heartbeat endpoint (from extension)
  app.post("/api/heartbeat", heartbeatLimiter, async (req, res) => {
    try {
      const data = insertHeartbeatSchema.parse(req.body);
      
      const heartbeat = await storage.addHeartbeat(data);
      
      // Notify teachers of update
      broadcastToTeachers({
        type: 'student-update',
        deviceId: data.deviceId,
      });

      res.json({ success: true, heartbeat });
    } catch (error) {
      console.error("Heartbeat error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Event logging endpoint (from extension)
  app.post("/api/event", apiLimiter, async (req, res) => {
    try {
      const data = insertEventSchema.parse(req.body);
      
      const event = await storage.addEvent(data);
      
      // Notify teachers of important events
      if (['consent_granted', 'consent_revoked', 'blocked_domain'].includes(data.eventType)) {
        broadcastToTeachers({
          type: 'student-event',
          data: event,
        });
      }

      res.json({ success: true, event });
    } catch (error) {
      console.error("Event error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Get all students with current status (for dashboard)
  app.get("/api/students", requireAuth, async (req, res) => {
    try {
      const statuses = await storage.getAllStudentStatuses();
      res.json(statuses);
    } catch (error) {
      console.error("Get students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get heartbeat history for a specific device
  app.get("/api/heartbeats/:deviceId", requireAuth, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;
      
      const heartbeats = await storage.getHeartbeatsByDevice(deviceId, limit);
      res.json(heartbeats);
    } catch (error) {
      console.error("Get heartbeats error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // WebRTC signaling endpoint
  app.post("/api/signal/:deviceId", apiLimiter, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const signal: SignalMessage = req.body;
      
      // Forward signal via WebSocket to the target device
      let sent = false;
      wsClients.forEach((client, ws) => {
        if (client.deviceId === deviceId && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'signal', data: signal }));
          sent = true;
        }
      });

      res.json({ success: sent });
    } catch (error) {
      console.error("Signal error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Settings endpoints
  app.get("/api/settings", requireAuth, async (req, res) => {
    try {
      let settings = await storage.getSettings();
      
      // Create default settings if none exist
      if (!settings) {
        settings = await storage.upsertSettings({
          schoolId: process.env.SCHOOL_ID || "default-school",
          schoolName: "School",
          wsSharedKey: process.env.WS_SHARED_KEY || "change-this-key",
          retentionHours: "24",
          blockedDomains: [],
        });
      }
      
      res.json(settings);
    } catch (error) {
      console.error("Get settings error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/settings", requireAuth, async (req, res) => {
    try {
      const data = insertSettingsSchema.parse(req.body);
      const settings = await storage.upsertSettings(data);
      res.json(settings);
    } catch (error) {
      console.error("Update settings error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Roster upload endpoint
  app.post("/api/roster/upload", requireAuth, async (req, res) => {
    try {
      // In a real implementation, this would parse the CSV file
      // For now, we'll accept JSON data
      const data = insertRosterSchema.parse(req.body);
      const roster = await storage.upsertRoster(data);
      res.json({ success: true, roster });
    } catch (error) {
      console.error("Roster upload error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Export CSV endpoint
  app.get("/api/export/csv", requireAuth, async (req, res) => {
    try {
      const students = await storage.getAllStudents();
      const statuses = await storage.getAllStudentStatuses();
      
      // Generate CSV
      let csv = "Device ID,Student Name,Class ID,Last Active Tab,Last URL,Last Seen,Status\n";
      
      statuses.forEach(status => {
        const student = students.find(s => s.deviceId === status.deviceId);
        if (student) {
          csv += `"${status.deviceId}","${status.studentName}","${status.classId}","${status.activeTabTitle}","${status.activeTabUrl}","${new Date(status.lastSeenAt).toISOString()}","${status.status}"\n`;
        }
      });
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=activity-export.csv');
      res.send(csv);
    } catch (error) {
      console.error("Export error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Data cleanup cron (run periodically)
  setInterval(async () => {
    try {
      const settings = await storage.getSettings();
      const retentionHours = parseInt(settings?.retentionHours || "24");
      const deleted = await storage.cleanupOldHeartbeats(retentionHours);
      if (deleted > 0) {
        console.log(`Cleaned up ${deleted} old heartbeats`);
      }
    } catch (error) {
      console.error("Cleanup error:", error);
    }
  }, 60 * 60 * 1000); // Run every hour

  return httpServer;
}

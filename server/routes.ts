import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import bcrypt from "bcrypt";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import * as XLSX from "xlsx";
import {
  insertStudentSchema,
  insertHeartbeatSchema,
  insertEventSchema,
  insertRosterSchema,
  insertSettingsSchema,
  loginSchema,
  createTeacherSchema,
  type StudentStatus,
  type SignalMessage,
} from "@shared/schema";
import { groupSessionsByDevice, formatDuration } from "@shared/utils";

// Rate limiters
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-device heartbeat rate limiter (critical for production)
const heartbeatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 120, // 120 requests per minute per device (2/sec is plenty)
  keyGenerator: (req) => {
    const { deviceId } = req.body || {};
    return `heartbeat:${deviceId || 'unknown'}`;
  },
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

// Admin middleware
async function requireAdmin(req: any, res: any, next: any) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  const user = await storage.getUser(req.session.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: "Forbidden: Admin access required" });
  }
  
  next();
}

// IP allowlist middleware (only enforced in production)
async function checkIPAllowlist(req: any, res: any, next: any) {
  // Skip IP check in development
  if (process.env.NODE_ENV !== 'production') {
    return next();
  }

  try {
    const settings = await storage.getSettings();
    
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
      res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
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

  // Get current user info
  app.get("/api/me", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          schoolName: user.schoolName,
        },
      });
    } catch (error) {
      console.error("Get user error:", error);
      res.status(500).json({ error: "Failed to fetch user" });
    }
  });

  // Admin routes for managing teachers
  app.get("/api/admin/teachers", requireAdmin, async (req, res) => {
    try {
      const users = await storage.getAllUsers();
      // Filter to only teachers (exclude admins) and remove passwords
      const teachers = users
        .filter(user => user.role === 'teacher')
        .map(user => ({
          id: user.id,
          username: user.username,
          role: user.role,
          schoolName: user.schoolName,
        }));
      res.json({ success: true, teachers });
    } catch (error) {
      console.error("Get teachers error:", error);
      res.status(500).json({ error: "Failed to fetch teachers" });
    }
  });

  app.post("/api/admin/teachers", requireAdmin, async (req, res) => {
    try {
      const data = createTeacherSchema.parse(req.body);
      
      // Check if username already exists
      const existing = await storage.getUserByUsername(data.username);
      if (existing) {
        return res.status(400).json({ error: "Username already exists" });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(data.password, 10);
      
      // Create teacher
      const teacher = await storage.createUser({
        username: data.username,
        password: hashedPassword,
        role: 'teacher',
        schoolName: data.schoolName || 'School',
      });

      res.json({ 
        success: true, 
        teacher: {
          id: teacher.id,
          username: teacher.username,
          role: teacher.role,
          schoolName: teacher.schoolName,
        }
      });
    } catch (error: any) {
      console.error("Create teacher error:", error);
      if (error.errors) {
        // Zod validation error
        res.status(400).json({ error: error.errors[0].message });
      } else {
        res.status(500).json({ error: "Failed to create teacher" });
      }
    }
  });

  app.delete("/api/admin/teachers/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      
      // Don't allow deleting yourself
      if (id === req.session.userId) {
        return res.status(400).json({ error: "Cannot delete your own account" });
      }

      // Verify the user exists and is a teacher (not an admin)
      const user = await storage.getUser(id);
      if (!user) {
        return res.status(404).json({ error: "Teacher not found" });
      }
      
      if (user.role === 'admin') {
        return res.status(403).json({ error: "Cannot delete admin accounts" });
      }

      await storage.deleteUser(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete teacher error:", error);
      res.status(500).json({ error: "Failed to delete teacher" });
    }
  });

  // Admin: Clean up all student data
  app.post("/api/admin/cleanup-students", requireAdmin, async (req, res) => {
    try {
      // Delete all students and heartbeats
      await storage.deleteAllStudents();
      
      // Notify all connected teachers
      broadcastToTeachers({
        type: 'students-cleared',
      });
      
      res.json({ success: true, message: 'All student data cleared successfully' });
    } catch (error) {
      console.error("Cleanup error:", error);
      res.status(500).json({ error: "Failed to cleanup student data" });
    }
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
  app.get("/api/students", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const statuses = await storage.getAllStudentStatuses();
      res.json(statuses);
    } catch (error) {
      console.error("Get students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all persisted students from database (for roster management)
  app.get("/api/roster/students", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const students = await storage.getAllStudents();
      res.json(students);
    } catch (error) {
      console.error("Get roster students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Create student manually (for roster management)
  app.post("/api/roster/student", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { studentName, deviceId, classId, gradeLevel } = req.body;
      
      if (!studentName || typeof studentName !== 'string') {
        return res.status(400).json({ error: "Student name is required" });
      }
      
      if (!deviceId || typeof deviceId !== 'string') {
        return res.status(400).json({ error: "Device ID is required" });
      }
      
      const studentData = {
        deviceId,
        studentName,
        schoolId: process.env.SCHOOL_ID || "default-school",
        classId: classId || "general",
        gradeLevel: gradeLevel || null,
      };
      
      const student = await storage.registerStudent(studentData);
      
      // Broadcast update to teachers
      broadcastToTeachers({
        type: 'student-update',
        deviceId: student.deviceId,
      });
      
      res.json({ success: true, student });
    } catch (error) {
      console.error("Create student error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Bulk create students
  app.post("/api/roster/bulk", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { students: studentsData } = req.body;
      
      if (!Array.isArray(studentsData) || studentsData.length === 0) {
        return res.status(400).json({ error: "Students array is required" });
      }
      
      const createdStudents = [];
      const errors = [];
      
      for (const studentInput of studentsData) {
        try {
          const studentData = {
            deviceId: studentInput.deviceId,
            studentName: studentInput.studentName,
            schoolId: process.env.SCHOOL_ID || "default-school",
            classId: studentInput.classId || "general",
            gradeLevel: studentInput.gradeLevel || null,
          };
          
          const student = await storage.registerStudent(studentData);
          createdStudents.push(student);
        } catch (error) {
          errors.push({
            deviceId: studentInput.deviceId,
            error: error instanceof Error ? error.message : "Failed to create student"
          });
        }
      }
      
      // Broadcast update to teachers
      broadcastToTeachers({
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

  // Update student information (name, device name, grade level, class)
  app.patch("/api/students/:deviceId", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const updates: Partial<{studentName: string; deviceName: string | null; classId: string; gradeLevel: string | null}> = {};
      
      if (req.body.studentName) {
        updates.studentName = req.body.studentName;
      }
      if ('deviceName' in req.body) {
        updates.deviceName = req.body.deviceName;
      }
      if (req.body.classId) {
        updates.classId = req.body.classId;
      }
      if ('gradeLevel' in req.body) {
        updates.gradeLevel = req.body.gradeLevel;
      }
      
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }
      
      const student = await storage.updateStudent(deviceId, updates);
      
      if (!student) {
        return res.status(404).json({ error: "Device not found" });
      }
      
      // Broadcast update to teachers
      broadcastToTeachers({
        type: 'student-update',
        deviceId: student.deviceId,
      });
      
      res.json({ success: true, student });
    } catch (error) {
      console.error("Update student error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Delete student device (cleanup duplicate/old devices)
  app.delete("/api/students/:deviceId", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const { deviceId } = req.params;
      
      const deleted = await storage.deleteStudent(deviceId);
      
      if (!deleted) {
        return res.status(404).json({ error: "Device not found" });
      }
      
      // Broadcast update to teachers
      broadcastToTeachers({
        type: 'student-update',
        deviceId,
      });
      
      res.json({ success: true });
    } catch (error) {
      console.error("Delete student error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get heartbeat history for a specific device
  app.get("/api/heartbeats/:deviceId", checkIPAllowlist, requireAuth, async (req, res) => {
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

  // Ping student endpoint - sends notification to student device
  app.post("/api/ping/:deviceId", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const { message } = req.body;
      
      // Forward ping message via WebSocket to the target device
      let sent = false;
      wsClients.forEach((client, ws) => {
        if (client.deviceId === deviceId && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'ping', 
            data: { 
              message: message || 'Your teacher is requesting your attention',
              timestamp: Date.now()
            } 
          }));
          sent = true;
        }
      });

      if (sent) {
        res.json({ success: true, message: "Ping sent successfully" });
      } else {
        res.json({ success: false, message: "Student is offline" });
      }
    } catch (error) {
      console.error("Ping error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Settings endpoints
  app.get("/api/settings", checkIPAllowlist, requireAuth, async (req, res) => {
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
          ipAllowlist: [],
        });
      }
      
      res.json(settings);
    } catch (error) {
      console.error("Get settings error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/settings", checkIPAllowlist, requireAuth, async (req, res) => {
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
  app.post("/api/roster/upload", checkIPAllowlist, requireAuth, async (req, res) => {
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

  // Export activity Excel endpoint with date range filtering
  app.get("/api/export/activity", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : new Date(Date.now() - 24 * 60 * 60 * 1000);
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();
      
      // Get all heartbeats within date range
      const allHeartbeats = await storage.getAllHeartbeats();
      const filteredHeartbeats = allHeartbeats.filter(hb => {
        const timestamp = new Date(hb.timestamp);
        return timestamp >= startDate && timestamp <= endDate;
      });
      
      // Get all students to map deviceId to studentName
      const students = await storage.getAllStudents();
      const studentMap = new Map(students.map(s => [s.deviceId, s.studentName]));
      
      // Calculate URL sessions with duration for each device
      const deviceSessions = groupSessionsByDevice(filteredHeartbeats);
      
      // Prepare data for Excel with duration information
      const data: any[] = [];
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
          return a['Device ID'].localeCompare(b['Device ID']);
        }
        return new Date(a['Start Time']).getTime() - new Date(b['Start Time']).getTime();
      });
      
      // Create workbook and worksheet
      const worksheet = XLSX.utils.json_to_sheet(data);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Activity Report');
      
      // Set column widths for better readability
      worksheet['!cols'] = [
        { wch: 15 }, // Device ID
        { wch: 20 }, // Student Name
        { wch: 20 }, // Start Time
        { wch: 20 }, // End Time
        { wch: 12 }, // Duration
        { wch: 12 }, // Duration (seconds)
        { wch: 50 }, // URL
        { wch: 40 }  // Tab Title
      ];
      
      // Generate Excel file buffer
      const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=activity-export-${new Date().toISOString().split('T')[0]}.xlsx`);
      res.send(excelBuffer);
    } catch (error) {
      console.error("Export activity error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Legacy export endpoint (for backward compatibility)
  app.get("/api/export/csv", checkIPAllowlist, requireAuth, async (req, res) => {
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

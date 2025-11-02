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
  insertDeviceSchema,
  insertStudentSchema,
  insertHeartbeatSchema,
  insertEventSchema,
  insertRosterSchema,
  insertSettingsSchema,
  insertSceneSchema,
  insertStudentGroupSchema,
  loginSchema,
  createTeacherSchema,
  type StudentStatus,
  type SignalMessage,
  type InsertRoster,
  type InsertStudent,
  type InsertDevice,
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

function broadcastToStudents(message: any, filterFn?: (client: WSClient) => boolean, targetDeviceIds?: string[]) {
  const messageStr = JSON.stringify(message);
  wsClients.forEach((client, ws) => {
    if (client.role === 'student' && client.authenticated && ws.readyState === WebSocket.OPEN) {
      // If targetDeviceIds is specified, only send to those devices
      if (targetDeviceIds && targetDeviceIds.length > 0) {
        if (!targetDeviceIds.includes(client.deviceId || '')) {
          return;
        }
      }
      // Apply additional filter function if provided
      if (!filterFn || filterFn(client)) {
        ws.send(messageStr);
      }
    }
  });
}

function sendToDevice(deviceId: string, message: any) {
  const messageStr = JSON.stringify(message);
  wsClients.forEach((client, ws) => {
    if (client.deviceId === deviceId && client.authenticated && ws.readyState === WebSocket.OPEN) {
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
            
            // Get school settings and send maxTabsPerStudent to extension
            try {
              const settings = await storage.getSettings();
              // Always send maxTabsPerStudent (including null for unlimited)
              // Parse the value if it exists, otherwise use null
              let maxTabs: number | null = null;
              if (settings?.maxTabsPerStudent !== null && settings?.maxTabsPerStudent !== undefined) {
                const parsed = parseInt(settings.maxTabsPerStudent, 10);
                // Only use parsed value if it's a valid positive integer
                // Treat 0, negative, or invalid as unlimited (null)
                maxTabs = (!isNaN(parsed) && parsed > 0) ? parsed : null;
              }
              
              ws.send(JSON.stringify({ 
                type: 'auth-success', 
                role: 'student',
                settings: {
                  maxTabsPerStudent: maxTabs
                }
              }));
            } catch (error) {
              console.error('Error fetching settings for student auth:', error);
              // Even on error, send null to indicate no limit
              ws.send(JSON.stringify({ 
                type: 'auth-success', 
                role: 'student',
                settings: {
                  maxTabsPerStudent: null
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

          console.log(`[WebSocket] Routing ${message.type} from ${client.deviceId} to ${targetDeviceId}`);

          // Find the target client (student or teacher)
          for (const [targetWs, targetClient] of Array.from(wsClients.entries())) {
            if (targetClient.role === 'student' && targetClient.deviceId === targetDeviceId) {
              targetWs.send(JSON.stringify({
                type: message.type,
                from: client.role === 'teacher' ? 'teacher' : client.deviceId,
                ...message
              }));
              console.log(`[WebSocket] Sent ${message.type} to student ${targetDeviceId}`);
              break;
            } else if (targetClient.role === 'teacher' && message.to === 'teacher') {
              const payload = {
                type: message.type,
                from: client.deviceId,
                ...message
              };
              targetWs.send(JSON.stringify(payload));
              console.log(`[WebSocket] Sent ${message.type} to teacher with from=${client.deviceId}`);
              break;
            }
          }
        }

        // Handle request to start screen sharing from teacher to student
        if (message.type === 'request-stream' && client.role === 'teacher') {
          const targetDeviceId = message.deviceId;
          if (!targetDeviceId) return;

          for (const [targetWs, targetClient] of Array.from(wsClients.entries())) {
            if (targetClient.role === 'student' && targetClient.deviceId === targetDeviceId) {
              targetWs.send(JSON.stringify({
                type: 'request-stream',
                from: 'teacher'
              }));
              break;
            }
          }
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

  // Client configuration endpoint (no auth required for Chrome Extension)
  app.get("/api/client-config", async (req, res) => {
    try {
      // Always use production URL for Chrome Extension compatibility
      const config = {
        baseUrl: 'https://classpilot.replit.app',
      };
      res.json(config);
    } catch (error) {
      console.error('Client config error:', error);
      res.status(500).json({ error: 'Failed to get client configuration' });
    }
  });

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
      // Delete all students (student assignments)
      const allStudents = await storage.getAllStudents();
      for (const student of allStudents) {
        await storage.deleteStudent(student.id);
      }
      
      // Delete all devices
      const allDevices = await storage.getAllDevices();
      for (const device of allDevices) {
        await storage.deleteDevice(device.deviceId);
      }
      
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

  // Device registration (from extension)
  app.post("/api/register", apiLimiter, async (req, res) => {
    try {
      const { deviceId, deviceName, classId, schoolId = 'default-school' } = req.body;
      
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
        const students = await storage.getStudentsByDevice(deviceData.deviceId);
        return res.json({ success: true, device: existing, students });
      }

      const device = await storage.registerDevice(deviceData);
      
      // Notify teachers
      broadcastToTeachers({
        type: 'device-registered',
        data: device,
      });

      res.json({ success: true, device, students: [] });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Student auto-registration with email (from extension using Chrome Identity API)
  app.post("/api/register-student", apiLimiter, async (req, res) => {
    try {
      const { deviceId, deviceName, classId, schoolId = 'default-school', studentEmail, studentName } = req.body;
      
      // Validate required fields
      if (!studentEmail || !studentName) {
        return res.status(400).json({ error: "studentEmail and studentName are required" });
      }
      
      // Register or update device
      const deviceData = insertDeviceSchema.parse({
        deviceId,
        deviceName: deviceName || null,
        classId,
        schoolId,
      });
      
      let device = await storage.getDevice(deviceData.deviceId);
      if (!device) {
        device = await storage.registerDevice(deviceData);
      }
      
      // Check if student with this email already exists on this device
      const existingStudents = await storage.getStudentsByDevice(deviceData.deviceId);
      let student = existingStudents.find(s => s.studentEmail === studentEmail);
      
      if (student) {
        // Student already exists for this device
        console.log('Student already registered:', studentEmail, 'studentId:', student.id);
      } else {
        // Create new student assignment
        const studentData = insertStudentSchema.parse({
          deviceId: deviceData.deviceId,
          studentName,
          studentEmail,
          gradeLevel: null, // Teacher can assign grade later
        });
        
        student = await storage.createStudent(studentData);
        console.log('New student auto-registered:', studentEmail, 'studentId:', student.id);
      }
      
      // Set this student as the active student for this device
      await storage.setActiveStudentForDevice(deviceData.deviceId, student.id);
      console.log('Set active student for device:', deviceData.deviceId, '→', student.id);
      
      // Notify teachers
      broadcastToTeachers({
        type: 'student-registered',
        data: { device, student },
      });

      res.json({ success: true, device, student });
    } catch (error) {
      console.error("Student registration error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Heartbeat endpoint (from extension) - bulletproof, never returns 500
  app.post("/api/heartbeat", heartbeatLimiter, async (req, res) => {
    try {
      // Validate input with safe parse
      const result = insertHeartbeatSchema.safeParse(req.body);
      
      if (!result.success) {
        console.warn('Invalid heartbeat data:', result.error.format(), req.body);
        // Return 204 even on validation failure to prevent extension from retrying
        return res.sendStatus(204);
      }
      
      const data = result.data;
      console.log('Heartbeat received:', { deviceId: data.deviceId, studentId: data.studentId, url: data.activeTabUrl?.substring(0, 50) });
      
      // Store heartbeat asynchronously - don't block the response
      storage.addHeartbeat(data)
        .then(() => {
          // Notify teachers of update (non-blocking)
          broadcastToTeachers({
            type: 'student-update',
            deviceId: data.deviceId,
          });
        })
        .catch((error) => {
          // Log but don't fail - we already responded to client
          console.error("Heartbeat storage error:", error, "deviceId:", data.deviceId);
        });
      
      // Always return success immediately
      return res.sendStatus(204);
    } catch (error) {
      // Final safety net - never throw
      console.error("Heartbeat uncaught error:", error, req.body);
      return res.sendStatus(204);
    }
  });

  // Event logging endpoint (from extension) - bulletproof, never returns 500
  app.post("/api/event", apiLimiter, async (req, res) => {
    try {
      // Validate input with safe parse
      const result = insertEventSchema.safeParse(req.body);
      
      if (!result.success) {
        console.warn('Invalid event data:', result.error.format(), req.body);
        // Return 204 to prevent extension from retrying
        return res.sendStatus(204);
      }
      
      const data = result.data;
      
      // Store event asynchronously - don't block the response
      storage.addEvent(data)
        .then((event) => {
          // Notify teachers of important events (non-blocking)
          if (['consent_granted', 'consent_revoked', 'blocked_domain', 'navigation', 'url_change'].includes(data.eventType)) {
            broadcastToTeachers({
              type: 'student-event',
              data: event,
            });
          }
        })
        .catch((error) => {
          // Log but don't fail - we already responded to client
          console.error("Event storage error:", error, "deviceId:", data.deviceId);
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
  app.get("/api/students", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const statuses = await storage.getAllStudentStatuses();
      console.log('Dashboard requested students - found:', statuses.length, 'students');
      statuses.forEach(s => {
        console.log(`  - ${s.studentName} (grade: ${s.gradeLevel}, status: ${s.status})`);
      });
      res.json(statuses);
    } catch (error) {
      console.error("Get students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get students assigned to a specific device (for extension popup)
  app.get("/api/device/:deviceId/students", apiLimiter, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const students = await storage.getStudentsByDevice(deviceId);
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
  app.post("/api/device/:deviceId/active-student", apiLimiter, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const { studentId } = req.body;
      
      // Verify student exists and belongs to this device
      if (studentId) {
        const student = await storage.getStudent(studentId);
        if (!student || student.deviceId !== deviceId) {
          return res.status(400).json({ error: "Invalid student for this device" });
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
  app.get("/api/roster/students", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const students = await storage.getAllStudents();
      res.json(students);
    } catch (error) {
      console.error("Get roster students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all devices from database (for roster management)
  app.get("/api/roster/devices", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const devices = await storage.getAllDevices();
      res.json(devices);
    } catch (error) {
      console.error("Get roster devices error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Create student manually (for roster management)
  app.post("/api/roster/student", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
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
      
      const studentData = insertStudentSchema.parse({
        deviceId,
        studentName,
        gradeLevel: gradeLevel || null,
      });
      
      const student = await storage.createStudent(studentData);
      
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
          const studentData = insertStudentSchema.parse({
            deviceId: studentInput.deviceId,
            studentName: studentInput.studentName,
            gradeLevel: studentInput.gradeLevel || null,
          });
          
          const student = await storage.createStudent(studentData);
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

  // Update student information (student name and grade level)
  app.patch("/api/students/:studentId", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const { studentId } = req.params;
      const updates: Partial<InsertStudent> = {};
      
      if ('studentName' in req.body) {
        updates.studentName = req.body.studentName;
      }
      if ('gradeLevel' in req.body) {
        updates.gradeLevel = req.body.gradeLevel || null;
      }
      
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }
      
      const student = await storage.updateStudent(studentId, updates);
      
      if (!student) {
        return res.status(404).json({ error: "Student not found" });
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

  // Update device information (device name and class assignment)
  app.patch("/api/devices/:deviceId", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const { deviceId } = req.params;
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
      
      const device = await storage.updateDevice(deviceId, updates);
      
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      
      // Broadcast update to teachers
      broadcastToTeachers({
        type: 'device-update',
        deviceId: device.deviceId,
      });
      
      res.json({ success: true, device });
    } catch (error) {
      console.error("Update device error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Delete student assignment
  app.delete("/api/students/:studentId", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const { studentId } = req.params;
      
      // Get student info before deleting for broadcast
      const student = await storage.getStudent(studentId);
      const deviceId = student?.deviceId;
      
      const deleted = await storage.deleteStudent(studentId);
      
      if (!deleted) {
        return res.status(404).json({ error: "Student not found" });
      }
      
      // Broadcast update to teachers
      if (deviceId) {
        broadcastToTeachers({
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

  // Delete device and all its student assignments
  app.delete("/api/devices/:deviceId", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const { deviceId } = req.params;
      
      const deleted = await storage.deleteDevice(deviceId);
      
      if (!deleted) {
        return res.status(404).json({ error: "Device not found" });
      }
      
      // Broadcast update to teachers
      broadcastToTeachers({
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

  // Scenes CRUD endpoints
  app.get("/api/scenes", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const scenes = await storage.getAllScenes();
      res.json(scenes);
    } catch (error) {
      console.error("Get scenes error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/scenes/:id", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const scene = await storage.getScene(req.params.id);
      if (!scene) {
        return res.status(404).json({ error: "Scene not found" });
      }
      res.json(scene);
    } catch (error) {
      console.error("Get scene error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/scenes", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const data = insertSceneSchema.parse(req.body);
      const scene = await storage.createScene(data);
      res.json(scene);
    } catch (error) {
      console.error("Create scene error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.patch("/api/scenes/:id", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const updates = insertSceneSchema.partial().parse(req.body);
      const scene = await storage.updateScene(req.params.id, updates);
      if (!scene) {
        return res.status(404).json({ error: "Scene not found" });
      }
      res.json(scene);
    } catch (error) {
      console.error("Update scene error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.delete("/api/scenes/:id", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const success = await storage.deleteScene(req.params.id);
      if (!success) {
        return res.status(404).json({ error: "Scene not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Delete scene error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Student Groups CRUD endpoints
  app.get("/api/groups", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const groups = await storage.getAllStudentGroups();
      res.json(groups);
    } catch (error) {
      console.error("Get groups error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/groups/:id", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const group = await storage.getStudentGroup(req.params.id);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }
      res.json(group);
    } catch (error) {
      console.error("Get group error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/groups", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const data = insertStudentGroupSchema.parse(req.body);
      const group = await storage.createStudentGroup(data);
      res.json(group);
    } catch (error) {
      console.error("Create group error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.patch("/api/groups/:id", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const updates = insertStudentGroupSchema.partial().parse(req.body);
      const group = await storage.updateStudentGroup(req.params.id, updates);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }
      res.json(group);
    } catch (error) {
      console.error("Update group error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.delete("/api/groups/:id", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const success = await storage.deleteStudentGroup(req.params.id);
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
  app.get("/api/rosters", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const rosters = await storage.getAllRosters();
      res.json(rosters);
    } catch (error) {
      console.error("Get rosters error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Create or update a roster/class
  app.post("/api/rosters", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { className, classId } = req.body;
      
      if (!className || typeof className !== 'string') {
        return res.status(400).json({ error: "Class name is required" });
      }
      
      if (!classId || typeof classId !== 'string') {
        return res.status(400).json({ error: "Class ID is required" });
      }
      
      // Check for duplicate classId
      const existing = await storage.getRoster(classId);
      if (existing) {
        return res.status(400).json({ error: "A class with this name already exists" });
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

  // Remote Control API Routes (Phase 1: GoGuardian-style features)
  
  // Open Tab - Push URL to all students or specific students
  app.post("/api/remote/open-tab", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { url, targetDeviceIds } = req.body;
      
      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }
      
      // Broadcast to targeted students or all students
      broadcastToStudents({
        type: 'remote-control',
        command: {
          type: 'open-tab',
          data: { url },
        },
      }, undefined, targetDeviceIds);
      
      const target = targetDeviceIds && targetDeviceIds.length > 0 
        ? `${targetDeviceIds.length} student(s)` 
        : "all students";
      res.json({ success: true, message: `Opened ${url} on ${target}` });
    } catch (error) {
      console.error("Open tab error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  // Close Tabs - Close all or specific tabs
  app.post("/api/remote/close-tabs", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { closeAll, pattern, allowedDomains, targetDeviceIds } = req.body;
      
      broadcastToStudents({
        type: 'remote-control',
        command: {
          type: 'close-tab',
          data: { closeAll, pattern, allowedDomains },
        },
      }, undefined, targetDeviceIds);
      
      const target = targetDeviceIds && targetDeviceIds.length > 0 
        ? `${targetDeviceIds.length} student(s)` 
        : "all students";
      res.json({ success: true, message: `Closed tabs on ${target}` });
    } catch (error) {
      console.error("Close tabs error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  // Lock Screens - Lock students to specific URL
  app.post("/api/remote/lock-screen", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { url, targetDeviceIds } = req.body;
      
      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }
      
      broadcastToStudents({
        type: 'remote-control',
        command: {
          type: 'lock-screen',
          data: { url },
        },
      }, undefined, targetDeviceIds);
      
      // Immediately update StudentStatus for instant UI feedback
      const deviceIdsToUpdate = targetDeviceIds && targetDeviceIds.length > 0 
        ? targetDeviceIds 
        : (await storage.getAllDevices()).map(d => d.deviceId);
      
      const now = Date.now();
      for (const deviceId of deviceIdsToUpdate) {
        const activeStudent = await storage.getActiveStudentForDevice(deviceId);
        if (activeStudent) {
          const status = await storage.getStudentStatus(activeStudent.id);
          if (status) {
            status.screenLocked = true;
            status.screenLockedSetAt = now; // Prevent heartbeat overwrite for 5 seconds
            await storage.updateStudentStatus(status);
          }
        }
      }
      
      // Notify teachers to update UI immediately
      broadcastToTeachers({
        type: 'student-update',
      });
      
      const target = targetDeviceIds && targetDeviceIds.length > 0 
        ? `${targetDeviceIds.length} student(s)` 
        : "all students";
      res.json({ success: true, message: `Locked ${target} to ${url}` });
    } catch (error) {
      console.error("Lock screen error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  // Unlock Screens
  app.post("/api/remote/unlock-screen", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { targetDeviceIds } = req.body;
      
      broadcastToStudents({
        type: 'remote-control',
        command: {
          type: 'unlock-screen',
          data: {},
        },
      }, undefined, targetDeviceIds);
      
      // Immediately update StudentStatus for instant UI feedback
      const deviceIdsToUpdate = targetDeviceIds && targetDeviceIds.length > 0 
        ? targetDeviceIds 
        : (await storage.getAllDevices()).map(d => d.deviceId);
      
      const now = Date.now();
      for (const deviceId of deviceIdsToUpdate) {
        const activeStudent = await storage.getActiveStudentForDevice(deviceId);
        if (activeStudent) {
          const status = await storage.getStudentStatus(activeStudent.id);
          if (status) {
            status.screenLocked = false;
            status.screenLockedSetAt = now; // Prevent heartbeat overwrite for 5 seconds
            await storage.updateStudentStatus(status);
          }
        }
      }
      
      // Notify teachers to update UI immediately
      broadcastToTeachers({
        type: 'student-update',
      });
      
      const target = targetDeviceIds && targetDeviceIds.length > 0 
        ? `${targetDeviceIds.length} student(s)` 
        : "all students";
      res.json({ success: true, message: `Unlocked ${target}` });
    } catch (error) {
      console.error("Unlock screen error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  // Apply Scene
  app.post("/api/remote/apply-scene", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { sceneId, allowedDomains, targetDeviceIds } = req.body;
      
      if (!sceneId || !allowedDomains || !Array.isArray(allowedDomains)) {
        return res.status(400).json({ error: "Scene ID and allowed domains are required" });
      }
      
      // Fetch scene details to get the scene name
      const scene = await storage.getScene(sceneId);
      const sceneName = scene?.sceneName || 'Unknown Scene';
      
      broadcastToStudents({
        type: 'remote-control',
        command: {
          type: 'apply-scene',
          data: { 
            sceneId,
            sceneName,
            allowedDomains 
          },
        },
      }, undefined, targetDeviceIds);
      
      const target = targetDeviceIds && targetDeviceIds.length > 0 
        ? `${targetDeviceIds.length} student(s)` 
        : "all students";
      res.json({ success: true, message: `Applied scene "${sceneName}" to ${target}` });
    } catch (error) {
      console.error("Apply scene error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  // Limit Tabs
  app.post("/api/remote/limit-tabs", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { maxTabs } = req.body;
      
      broadcastToStudents({
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
  
  // Send Chat Message
  app.post("/api/chat/send", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { message, toDeviceId } = req.body;
      
      if (!req.session?.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
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
        // Send to specific device
        sendToDevice(toDeviceId, chatMessage);
      } else {
        // Broadcast to all
        broadcastToStudents(chatMessage);
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Send chat error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  
  // Send Check-in Request
  app.post("/api/checkin/request", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { question, options } = req.body;
      
      if (!question || !options || !Array.isArray(options)) {
        return res.status(400).json({ error: "Question and options are required" });
      }
      
      broadcastToStudents({
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

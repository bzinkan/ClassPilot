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
  insertFlightPathSchema,
  insertStudentGroupSchema,
  insertDashboardTabSchema,
  insertGroupSchema,
  insertSessionSchema,
  loginSchema,
  createTeacherSchema,
  type Student,
  type StudentStatus,
  type SignalMessage,
  type InsertRoster,
  type InsertStudent,
  type InsertDevice,
} from "@shared/schema";
import { groupSessionsByDevice, formatDuration, isWithinTrackingHours, normalizeEmail } from "@shared/utils";

// Helper function to normalize grade levels (strip ordinal suffixes like "th", "st", "nd", "rd")
function normalizeGradeLevel(grade: string | null | undefined): string | null {
  if (!grade) return null;
  
  const trimmed = grade.trim();
  if (!trimmed) return null;
  
  // Remove common ordinal suffixes (case-insensitive)
  // Matches: 1st, 2nd, 3rd, 4th, 5th, etc. and returns just the number
  const normalized = trimmed.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
  
  // Also handle special cases like "Kindergarten" → "K"
  if (/^kindergarten$/i.test(normalized)) {
    return 'K';
  }
  
  return normalized;
}

// Rate limiters
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-device heartbeat rate limiter (critical for production)
// Increased limit to 1000/min to prevent rate limiting issues with Chrome Extensions
const heartbeatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 1000, // 1000 requests per minute per device (extensions send ~6/min, but allow headroom for retries)
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
  userId?: string; // For teachers - needed for permission checks
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

function broadcastToStudents(message: any, filterFn?: (client: WSClient) => boolean, targetDeviceIds?: string[]): number {
  const messageStr = JSON.stringify(message);
  let sentCount = 0;
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
        sentCount++;
      }
    }
  });
  return sentCount;
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
            // Store teacher userId for permission checks
            client.role = 'teacher';
            client.userId = message.userId; // Store userId from auth message
            client.authenticated = true;
            console.log('[WebSocket] Teacher authenticated with userId:', client.userId);
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

          // Permission check: Verify teacher has access to this student
          if (client.userId) {
            try {
              // Get the user to check role
              const user = await storage.getUser(client.userId);
              
              // Admins can view all students; teachers need permission check
              if (user && user.role !== 'admin') {
                // Get the active student for this device
                const activeStudent = await storage.getActiveStudentForDevice(targetDeviceId);
                
                if (activeStudent) {
                  // Check if this student is assigned to the teacher
                  const teacherStudentIds = await storage.getTeacherStudents(client.userId);
                  
                  if (!teacherStudentIds.includes(activeStudent.id)) {
                    console.warn(`[WebSocket] Teacher ${client.userId} attempted to view student ${activeStudent.id} without permission`);
                    ws.send(JSON.stringify({
                      type: 'error',
                      message: 'You do not have permission to view this student\'s screen'
                    }));
                    return; // Block the request
                  }
                }
              }
            } catch (error) {
              console.error('[WebSocket] Permission check error:', error);
              // On error, allow the request (fail open for now)
            }
          }

          // Permission granted or admin - forward the request
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

        // Handle request to stop screen sharing from teacher to student
        if (message.type === 'stop-share' && client.role === 'teacher') {
          const targetDeviceId = message.deviceId;
          if (!targetDeviceId) return;

          console.log(`[WebSocket] Sending stop-share to ${targetDeviceId}`);
          for (const [targetWs, targetClient] of Array.from(wsClients.entries())) {
            if (targetClient.role === 'student' && targetClient.deviceId === targetDeviceId) {
              targetWs.send(JSON.stringify({
                type: 'stop-share',
                from: 'teacher'
              }));
              console.log(`[WebSocket] Sent stop-share to ${targetDeviceId}`);
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

  // Version endpoint for deployment verification
  app.get("/api/version", async (req, res) => {
    try {
      const version = {
        commit: '31fff44',
        timestamp: new Date().toISOString(),
        features: [
          'deviceId→studentId mapping',
          'rate-limit-1000/min',
          'session-based-roster-visibility'
        ]
      };
      res.json(version);
    } catch (error) {
      res.status(500).json({ error: 'Failed to get version' });
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

  // Admin: Get all teacher-student assignments
  app.get("/api/admin/teacher-students", requireAdmin, async (req, res) => {
    try {
      const users = await storage.getAllUsers();
      const students = await storage.getAllStudents();
      
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
  app.post("/api/admin/teacher-students/:teacherId", requireAdmin, async (req, res) => {
    try {
      const { teacherId } = req.params;
      const { studentIds } = req.body;
      
      if (!Array.isArray(studentIds)) {
        return res.status(400).json({ error: "studentIds must be an array" });
      }
      
      // Verify teacher exists
      const teacher = await storage.getUser(teacherId);
      if (!teacher || teacher.role !== 'teacher') {
        return res.status(404).json({ error: "Teacher not found" });
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
  app.delete("/api/admin/teacher-students/:teacherId/:studentId", requireAdmin, async (req, res) => {
    try {
      const { teacherId, studentId } = req.params;
      
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

  // Admin: Migrate existing teacher_students to groups system
  app.post("/api/admin/migrate-to-groups", requireAdmin, async (req, res) => {
    try {
      // Get all teachers and settings
      const allUsers = await storage.getAllUsers();
      const allTeachers = allUsers.filter(user => user.role === 'teacher');
      const settings = await storage.getSettings();
      const schoolId = settings?.schoolId || 'default-school';
      
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
            schoolId,
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

  // Admin: Bulk import students from CSV or Excel
  app.post("/api/admin/bulk-import", requireAdmin, async (req, res) => {
    try {
      const { fileContent, fileType, gradeLevel } = req.body;
      
      if (!fileContent) {
        return res.status(400).json({ error: "File content is required" });
      }

      // Validate grade level if provided
      if (gradeLevel) {
        const trimmed = gradeLevel.trim();
        if (!trimmed) {
          return res.status(400).json({ error: "Grade level cannot be empty" });
        }
        // Allow K, 1-12, or other common formats
        const gradePattern = /^(K|[1-9]|1[0-2])$/i;
        if (!gradePattern.test(trimmed) && !/^\d+$/.test(trimmed)) {
          return res.status(400).json({ 
            error: "Grade level must be K or a number (1-12)" 
          });
        }
      }

      // Parse file content using XLSX (supports both CSV and Excel)
      // For CSV: fileContent is a string, use type: 'string'
      // For Excel: fileContent is base64, use type: 'base64'
      const readType = fileType === 'excel' ? 'base64' : 'string';
      const workbook = XLSX.read(fileContent, { type: readType });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet) as any[];

      if (data.length === 0) {
        return res.status(400).json({ error: "File is empty" });
      }

      // Get settings for schoolId and deviceId generation
      const settings = await storage.getSettings();
      const schoolId = settings?.schoolId || 'default-school';
      const allGroups = await storage.getAllGroups();

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
          // Extract and validate fields (case-insensitive column names)
          const rawEmail = (row.Email || row.email || row.EMAIL || '').trim();
          const name = (row.Name || row.name || row.NAME || row.StudentName || row.studentName || '').trim();
          const className = (row.Class || row.class || row.CLASS || row.ClassName || row.className || '').trim();

          // Validate required fields
          if (!rawEmail) {
            results.errors.push(`Row ${rowNum}: Email is required`);
            continue;
          }

          if (!name) {
            results.errors.push(`Row ${rowNum}: Name is required`);
            continue;
          }

          // Validate email format
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(rawEmail)) {
            results.errors.push(`Row ${rowNum}: Invalid email format for ${rawEmail}`);
            continue;
          }

          // Normalize email for consistent storage and lookup
          const email = normalizeEmail(rawEmail) || '';

          // Use the grade level from the request (applies to all students in the import)
          const normalizedGrade = normalizeGradeLevel(gradeLevel) || null;

          // Check if student already exists by email (using normalized email)
          const allStudents = await storage.getAllStudents();
          let student = allStudents.find(s => normalizeEmail(s.studentEmail) === email);

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
                schoolId,
              });
            }

            student = await storage.createStudent({
              deviceId: placeholderDeviceId,
              studentName: name,
              studentEmail: email,
              gradeLevel: normalizedGrade,
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
          results.errors.push(`Row ${rowNum}: ${error.message || 'Unknown error'}`);
        }
      }

      // Notify all connected teachers of the update
      broadcastToTeachers({
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

  // Admin: Create a single student
  app.post("/api/admin/students", requireAdmin, async (req, res) => {
    try {
      const { studentName, studentEmail, gradeLevel, classId } = req.body;

      // Validate required fields
      if (!studentName || !studentEmail) {
        return res.status(400).json({ error: "Name and email are required" });
      }

      // Validate grade level if provided
      if (gradeLevel) {
        const trimmed = gradeLevel.trim();
        if (!trimmed) {
          return res.status(400).json({ error: "Grade level cannot be empty" });
        }
        // Allow K, 1-12, or other common formats
        const gradePattern = /^(K|[1-9]|1[0-2])$/i;
        if (!gradePattern.test(trimmed) && !/^\d+$/.test(trimmed)) {
          return res.status(400).json({ 
            error: "Grade level must be K or a number (1-12)" 
          });
        }
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(studentEmail)) {
        return res.status(400).json({ error: "Invalid email format" });
      }

      // Normalize email for consistent storage and lookup
      const normalizedEmail = normalizeEmail(studentEmail);

      // Check for duplicate email (using normalized comparison)
      const allStudents = await storage.getAllStudents();
      const existingStudent = allStudents.find(
        s => normalizeEmail(s.studentEmail) === normalizedEmail
      );

      if (existingStudent) {
        return res.status(400).json({ 
          error: `A student with email ${studentEmail} already exists` 
        });
      }

      // Get settings for schoolId
      const settings = await storage.getSettings();
      const schoolId = settings?.schoolId || 'default-school';

      // Normalize grade level
      const normalizedGrade = normalizeGradeLevel(gradeLevel) || null;

      // Create placeholder deviceId based on email
      const deviceId = `pending-${normalizedEmail?.split('@')[0]}-${Date.now()}`;

      // Create student with normalized email
      const student = await storage.createStudent({
        studentName,
        studentEmail: normalizedEmail,
        gradeLevel: normalizedGrade,
        deviceId,
      });

      // Assign to class if classId provided
      if (classId && student) {
        try {
          await storage.assignStudentToGroup(classId, student.id);
        } catch (error) {
          console.error("Failed to assign student to class:", error);
          // Continue - student was created successfully
        }
      }

      // Notify teachers
      broadcastToTeachers({
        type: 'students-updated',
      });

      res.json({
        success: true,
        message: 'Student created successfully',
        student,
      });
    } catch (error) {
      console.error("Create student error:", error);
      res.status(500).json({ error: "Failed to create student" });
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
      
      // Log if email is missing (indicates Chrome Identity API didn't provide it)
      if (!studentEmail) {
        console.warn('⚠️  Student registration without email - Chrome Identity API may lack permissions', {
          deviceId,
          studentName,
          classId
        });
      }
      
      // Validate studentName is provided
      if (!studentName) {
        return res.status(400).json({ error: "studentName is required" });
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
      
      let student: Student | undefined = undefined;
      
      // Path 1: Email provided - use email-based matching (preferred)
      if (studentEmail) {
        const normalizedEmail = normalizeEmail(studentEmail);
        if (!normalizedEmail) {
          return res.status(400).json({ error: "Invalid email address" });
        }
        
        console.log('🔍 EMAIL LOOKUP: Looking for student with email:', normalizedEmail, 'in school:', schoolId);
        
        // Check if student with this email already exists (for this school, across ALL devices)
        student = await storage.getStudentByEmail(schoolId, normalizedEmail);
        
        if (student) {
          // Student exists! Check if they are using this device
          console.log('✅ EMAIL MATCH FOUND: Student exists with id:', student.id, 'name:', student.studentName);
          
          // Check if student is already registered on this device
          const devices = await storage.getStudentDevices(student.id);
          const isOnThisDevice = devices.some(d => d.deviceId === deviceData.deviceId);
          
          if (!isOnThisDevice) {
            console.log('✓ Student using new device:', normalizedEmail, '→', deviceData.deviceId);
            // Add this device to the student's device list
            await storage.addStudentDevice(student.id, deviceData.deviceId);
          } else {
            console.log('✓ Student already registered on this device:', normalizedEmail, 'studentId:', student.id);
          }
        } else {
          // Create new student (first time seeing this email in this school)
          console.log('✓ Creating new student with email:', normalizedEmail);
          student = await storage.upsertStudent(schoolId, normalizedEmail, studentName, null);
          // Add this device to the student's device list
          await storage.addStudentDevice(student.id, deviceData.deviceId);
          console.log('✓ New student auto-registered with email:', normalizedEmail, 'studentId:', student.id);
        }
      } 
      // Path 2: No email provided - try to find existing student by checking placeholder devices
      else {
        // Get all students to check for potential matches
        const allStudents = await storage.getAllStudents();
        
        // Strategy A: Check if any student has a pending placeholder deviceId
        // These are created during CSV import with pattern: "pending-{email}"
        // Use getStudentDevices to check each student's devices
        let foundPendingStudent: Student | undefined = undefined;
        
        for (const s of allStudents) {
          const devices = await storage.getStudentDevices(s.id);
          const hasPendingDevice = devices.some(d => 
            d.deviceId.startsWith('pending-') && 
            d.deviceId !== deviceData.deviceId
          );
          
          if (hasPendingDevice) {
            foundPendingStudent = s;
            break;
          }
        }
        
        if (foundPendingStudent) {
          console.log('✓ Found CSV-imported student, linking to real device:', deviceData.deviceId);
          // Add the actual device to the student's device list
          await storage.addStudentDevice(foundPendingStudent.id, deviceData.deviceId);
          student = foundPendingStudent;
        } else {
          // Strategy B: Fail instead of creating duplicate
          // This prevents creating mystery students that teachers can't track
          return res.status(400).json({ 
            error: "Chrome Extension could not retrieve student email. Please ensure the extension has 'identity.email' permission, or manually assign this device to a student from the teacher dashboard.",
            details: {
              deviceId: deviceData.deviceId,
              missingEmail: true,
              suggestion: "Check Chrome Extension permissions or pre-import students via CSV"
            }
          });
        }
      }
      
      // Set this student as the active student for this device
      if (student) {
        await storage.setActiveStudentForDevice(deviceData.deviceId, student.id);
        console.log('✓ Set active student for device:', deviceData.deviceId, '→', student.id);
        
        // Notify teachers
        broadcastToTeachers({
          type: 'student-registered',
          data: { device, student },
        });

        res.json({ success: true, device, student });
      } else {
        // Should not reach here, but safety fallback
        return res.status(500).json({ error: "Failed to create or find student" });
      }
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
      
      // Check if tracking hours are enforced (timezone-aware)
      const settings = await storage.getSettings();
      if (!isWithinTrackingHours(
        settings?.enableTrackingHours,
        settings?.trackingStartTime,
        settings?.trackingEndTime,
        settings?.schoolTimezone,
        settings?.trackingDays
      )) {
        console.log('Heartbeat rejected - outside school tracking hours/days');
        // Return 204 to prevent extension from retrying, but don't store heartbeat
        return res.sendStatus(204);
      }
      
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
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const allStatuses = await storage.getAllStudentStatuses();
      
      // Admins see all students; teachers see only students in their active session
      let filteredStatuses: typeof allStatuses;
      if (user.role === 'admin') {
        filteredStatuses = allStatuses;
        console.log('Dashboard requested students (admin) - found:', filteredStatuses.length, 'students');
      } else {
        // Teachers: Only show students when they have an active session
        const activeSession = await storage.getActiveSessionByTeacher(userId);
        if (activeSession?.groupId) {
          console.log('Teacher has active session for group:', activeSession.groupId);
          
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
                if (!student) return null;
                
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
        } else {
          // No active session = no students shown (empty state)
          filteredStatuses = [];
          console.log('Teacher has no active session - showing empty state');
        }
      }
      
      filteredStatuses.forEach(s => {
        console.log(`  - ${s.studentName} (grade: ${s.gradeLevel}, status: ${s.status}, screenLocked: ${s.screenLocked})`);
      });
      res.json(filteredStatuses);
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
        gradeLevel: normalizeGradeLevel(gradeLevel),
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
            gradeLevel: normalizeGradeLevel(studentInput.gradeLevel),
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

  // Update student information (student name, email, and grade level)
  app.patch("/api/students/:studentId", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const { studentId } = req.params;
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
        // Normalize email for consistent storage
        updates.studentEmail = normalizeEmail(email);
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
      const limit = parseInt(req.query.limit as string) || 1000; // Fetch more history to show more sessions
      
      const heartbeats = await storage.getHeartbeatsByDevice(deviceId, limit);
      res.json(heartbeats);
    } catch (error) {
      console.error("Get heartbeats error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get website duration analytics for a student or all students
  app.get("/api/student-analytics/:studentId", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const { studentId } = req.params;
      const isAllStudents = studentId === "all";
      
      // Get heartbeats for the last 24 hours (or custom range)
      const allHeartbeats = await storage.getAllHeartbeats();
      const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
      
      // Filter heartbeats by student and time range
      let filteredHeartbeats = allHeartbeats.filter(hb => {
        const timestamp = new Date(hb.timestamp).getTime();
        if (timestamp < cutoffTime) return false;
        
        if (isAllStudents) return true;
        return hb.deviceId === studentId;
      });
      
      // Group by URL domain and calculate total duration
      const urlDurations = new Map<string, number>();
      
      // Sort by timestamp
      filteredHeartbeats.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      
      // Calculate duration for each URL
      for (let i = 0; i < filteredHeartbeats.length; i++) {
        const current = filteredHeartbeats[i];
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
          if (hostname.includes('.replit.dev')) {
            // Shorten Replit dev URLs to just "replit.dev"
            domain = 'replit.dev';
          } else if (hostname.includes('.riker.replit.dev')) {
            domain = 'replit.dev';
          } else if (hostname.startsWith('www.')) {
            domain = hostname.substring(4);
          } else if (hostname.includes('chrome://')) {
            domain = url.protocol.replace(':', '');
          } else {
            domain = hostname;
          }
        } catch {
          // If URL parsing fails, clean up common patterns
          if (domain.includes('chrome://')) {
            domain = 'chrome (extensions)';
          } else if (domain.includes('replit')) {
            domain = 'replit.dev';
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

  app.patch("/api/settings", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const currentSettings = await storage.getSettings();
      if (!currentSettings) {
        return res.status(404).json({ error: "Settings not found" });
      }

      // Merge current settings with request body for partial update
      const updatedData = { ...currentSettings, ...req.body };
      const data = insertSettingsSchema.parse(updatedData);
      const settings = await storage.upsertSettings(data);
      res.json(settings);
    } catch (error) {
      console.error("Update settings error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  // Teacher Settings endpoints
  app.get("/api/teacher/settings", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const teacherSettings = await storage.getTeacherSettings(teacherId);
      res.json(teacherSettings || null);
    } catch (error) {
      console.error("Get teacher settings error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/teacher/settings", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
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
  app.get("/api/teacher/students", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const studentIds = await storage.getTeacherStudents(teacherId);
      const students = await Promise.all(
        studentIds.map(id => storage.getStudent(id))
      );
      res.json(students.filter(s => s !== undefined));
    } catch (error) {
      console.error("Get teacher students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/teacher/students/:studentId/assign", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const { studentId } = req.params;
      const assignment = await storage.assignStudentToTeacher(teacherId, studentId);
      res.json(assignment);
    } catch (error) {
      console.error("Assign student error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/teacher/students/:studentId/unassign", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const { studentId } = req.params;
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
  app.get("/api/teacher/dashboard-tabs", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      let tabs = await storage.getDashboardTabs(teacherId);
      
      // Auto-generate default grade-level tabs if none exist
      if (tabs.length === 0) {
        const settings = await storage.getSettings();
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
  app.get("/api/teacher/groups", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      // Admins see all groups; teachers see only their own
      if (user.role === 'admin') {
        const allGroups = await storage.getAllGroups();
        return res.json(allGroups);
      }
      
      const groups = await storage.getGroupsByTeacher(userId);
      res.json(groups);
    } catch (error) {
      console.error("Get groups error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/teacher/groups", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      // Determine target teacherId
      let targetTeacherId = req.body.teacherId;
      
      // If not admin, force teacherId to be current user
      if (user.role !== 'admin') {
        targetTeacherId = userId;
      }
      
      // Validate targetTeacherId is provided
      if (!targetTeacherId) {
        return res.status(400).json({ error: "teacherId is required" });
      }
      
      // Set default groupType if not provided
      const groupType = req.body.groupType || 
        (user.role === 'admin' ? 'admin_class' : 'teacher_created');
      
      const data = insertGroupSchema.parse({ 
        ...req.body, 
        teacherId: targetTeacherId,
        groupType 
      });
      const group = await storage.createGroup(data);
      res.json(group);
    } catch (error) {
      console.error("Create group error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.patch("/api/teacher/groups/:id", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const { id } = req.params;
      
      // Verify ownership (admins can edit any group)
      const existingGroup = await storage.getGroup(id);
      if (!existingGroup) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      if (user.role !== 'admin' && existingGroup.teacherId !== userId) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      const group = await storage.updateGroup(id, req.body);
      res.json(group);
    } catch (error) {
      console.error("Update group error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.delete("/api/teacher/groups/:id", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const { id } = req.params;
      
      // Verify ownership (admins can delete any group)
      const existingGroup = await storage.getGroup(id);
      if (!existingGroup) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      if (user.role !== 'admin' && existingGroup.teacherId !== userId) {
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
  app.get("/api/groups/:groupId/students", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const { groupId } = req.params;
      
      // Get user to check role
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      // Verify ownership - admins can view any group, teachers only their own
      const group = await storage.getGroup(groupId);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }
      if (user.role !== 'admin' && group.teacherId !== userId) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      const studentIds = await storage.getGroupStudents(groupId);
      const students = await Promise.all(studentIds.map(id => storage.getStudent(id)));
      res.json(students.filter(s => s !== undefined));
    } catch (error) {
      console.error("Get group students error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/groups/:groupId/students/:studentId", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const { groupId, studentId } = req.params;
      
      // Get user to check role
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      // Verify ownership - admins can manage any group, teachers only their own
      const group = await storage.getGroup(groupId);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }
      if (user.role !== 'admin' && group.teacherId !== userId) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      const assignment = await storage.assignStudentToGroup(groupId, studentId);
      res.json(assignment);
    } catch (error) {
      console.error("Assign student to group error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/groups/:groupId/students/:studentId", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const { groupId, studentId } = req.params;
      
      // Get user to check role
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      // Verify ownership - admins can manage any group, teachers only their own
      const group = await storage.getGroup(groupId);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }
      if (user.role !== 'admin' && group.teacherId !== userId) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      const success = await storage.unassignStudentFromGroup(groupId, studentId);
      res.json({ success });
    } catch (error) {
      console.error("Unassign student from group error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Session endpoints
  app.post("/api/sessions/start", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const { groupId } = req.body;
      
      // Verify group ownership
      const group = await storage.getGroup(groupId);
      if (!group || group.teacherId !== teacherId) {
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

  app.post("/api/sessions/end", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const activeSession = await storage.getActiveSessionByTeacher(teacherId);
      if (!activeSession) {
        return res.status(404).json({ error: "No active session found" });
      }
      
      const session = await storage.endSession(activeSession.id);
      res.json(session);
    } catch (error) {
      console.error("End session error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/sessions/active", checkIPAllowlist, requireAuth, async (req, res) => {
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

  app.get("/api/sessions/all", checkIPAllowlist, requireAdmin, async (req, res) => {
    try {
      // Admin-only endpoint to view all active sessions school-wide
      const sessions = await storage.getActiveSessions();
      res.json(sessions);
    } catch (error) {
      console.error("Get all sessions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Flight Paths CRUD endpoints
  app.get("/api/flight-paths", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const allFlightPaths = await storage.getAllFlightPaths();
      
      // Admins see all flight paths; teachers see only their own + school-wide defaults
      const filteredFlightPaths = user.role === 'admin'
        ? allFlightPaths
        : allFlightPaths.filter(fp => fp.teacherId === userId || fp.teacherId === null);
      
      res.json(filteredFlightPaths);
    } catch (error) {
      console.error("Get flight paths error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/flight-paths/:id", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const flightPath = await storage.getFlightPath(req.params.id);
      if (!flightPath) {
        return res.status(404).json({ error: "Flight Path not found" });
      }
      res.json(flightPath);
    } catch (error) {
      console.error("Get flight path error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/flight-paths", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      // Make schoolId optional for teacher-scoped Flight Paths
      const flightPathSchema = insertFlightPathSchema.extend({
        schoolId: z.string().optional(),
      });
      const data = flightPathSchema.parse(req.body);
      
      // Get the default school ID from settings if not provided
      const settings = await storage.getSettings();
      const schoolId = data.schoolId || settings?.schoolId || 'default-school';
      
      // Ensure blockedDomains defaults to empty array if not provided
      const flightPath = await storage.createFlightPath({
        ...data,
        schoolId,
        teacherId: data.teacherId ?? teacherId,
        blockedDomains: data.blockedDomains ?? []
      });
      res.json(flightPath);
    } catch (error) {
      console.error("Create flight path error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.patch("/api/flight-paths/:id", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const updates = insertFlightPathSchema.partial().parse(req.body);
      
      // If blockedDomains is not provided, explicitly set it to empty array
      // to clear any previously saved blocked domains
      if (!('blockedDomains' in req.body)) {
        updates.blockedDomains = [];
      }
      
      const flightPath = await storage.updateFlightPath(req.params.id, updates);
      if (!flightPath) {
        return res.status(404).json({ error: "Flight Path not found" });
      }
      res.json(flightPath);
    } catch (error) {
      console.error("Update flight path error:", error);
      res.status(400).json({ error: "Invalid request" });
    }
  });

  app.delete("/api/flight-paths/:id", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
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

  // Student Groups CRUD endpoints
  app.get("/api/groups", checkIPAllowlist, requireAuth, async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const allGroups = await storage.getAllStudentGroups();
      
      // Admins see all groups; teachers see only their own + school-wide defaults
      const filteredGroups = user.role === 'admin'
        ? allGroups
        : allGroups.filter(group => group.teacherId === userId || group.teacherId === null);
      
      res.json(filteredGroups);
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
      const teacherId = req.session?.userId;
      if (!teacherId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const data = insertStudentGroupSchema.parse(req.body);
      const group = await storage.createStudentGroup({
        ...data,
        teacherId: data.teacherId ?? teacherId
      });
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
      const sentCount = broadcastToStudents({
        type: 'remote-control',
        command: {
          type: 'open-tab',
          data: { url },
        },
      }, undefined, targetDeviceIds);
      
      console.log(`Open tab command sent to ${sentCount} connected device(s)`);
      
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
  app.post("/api/remote/close-tabs", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { closeAll, pattern, specificUrls, allowedDomains, targetDeviceIds } = req.body;
      
      broadcastToStudents({
        type: 'remote-control',
        command: {
          type: 'close-tab',
          data: { closeAll, pattern, specificUrls, allowedDomains },
        },
      }, undefined, targetDeviceIds);
      
      const target = targetDeviceIds && targetDeviceIds.length > 0 
        ? `${targetDeviceIds.length} student(s)` 
        : "all students";
      
      const message = specificUrls && specificUrls.length > 0
        ? `Closed ${specificUrls.length} selected tab(s) on ${target}`
        : `Closed tabs on ${target}`;
      
      res.json({ success: true, message });
    } catch (error) {
      console.error("Close tabs error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  // Lock Screens - Lock students to specific URL or current URL
  app.post("/api/remote/lock-screen", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { url, targetDeviceIds } = req.body;
      
      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }
      
      // Send "CURRENT_URL" to extension to lock to whatever student is currently viewing
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
        // Try to get active student, fall back to all students for this device
        const activeStudent = await storage.getActiveStudentForDevice(deviceId);
        const studentsToUpdate = activeStudent 
          ? [activeStudent]
          : await storage.getStudentsByDevice(deviceId);
        
        for (const student of studentsToUpdate) {
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
        // Try to get active student, fall back to all students for this device
        const activeStudent = await storage.getActiveStudentForDevice(deviceId);
        const studentsToUpdate = activeStudent 
          ? [activeStudent]
          : await storage.getStudentsByDevice(deviceId);
        
        for (const student of studentsToUpdate) {
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
  
  // Apply Flight Path
  app.post("/api/remote/apply-flight-path", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { flightPathId, allowedDomains, targetDeviceIds } = req.body;
      
      if (!flightPathId || !allowedDomains || !Array.isArray(allowedDomains)) {
        return res.status(400).json({ error: "Flight Path ID and allowed domains are required" });
      }
      
      // Fetch flight path details to get the flight path name
      const flightPath = await storage.getFlightPath(flightPathId);
      const flightPathName = flightPath?.flightPathName || 'Unknown Flight Path';
      
      broadcastToStudents({
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
      
      const target = targetDeviceIds && targetDeviceIds.length > 0 
        ? `${targetDeviceIds.length} student(s)` 
        : "all students";
      res.json({ success: true, message: `Applied flight path "${flightPathName}" to ${target}` });
    } catch (error) {
      console.error("Apply flight path error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
  
  // Remove Flight Path
  app.post("/api/remote/remove-flight-path", checkIPAllowlist, requireAuth, apiLimiter, async (req, res) => {
    try {
      const { targetDeviceIds } = req.body;
      
      if (!targetDeviceIds || !Array.isArray(targetDeviceIds) || targetDeviceIds.length === 0) {
        return res.status(400).json({ error: "Target device IDs are required" });
      }
      
      broadcastToStudents({
        type: 'remote-control',
        command: {
          type: 'remove-flight-path',
          data: {},
        },
      }, undefined, targetDeviceIds);
      
      // Immediately update StudentStatus for instant UI feedback
      const now = Date.now();
      for (const deviceId of targetDeviceIds) {
        const activeStudent = await storage.getActiveStudentForDevice(deviceId);
        if (activeStudent) {
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
      broadcastToTeachers({
        type: 'student-update',
      });
      
      const target = `${targetDeviceIds.length} student(s)`;
      res.json({ success: true, message: `Removed flight path from ${target}` });
    } catch (error) {
      console.error("Remove flight path error:", error);
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

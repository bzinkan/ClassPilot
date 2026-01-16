/**
 * Audit logging helper functions
 * Logs admin/teacher actions for compliance and auditing
 */

import { Request } from "express";
import { storage } from "./storage";
import type { InsertAuditLog } from "@shared/schema";

// Common audit actions
export const AuditAction = {
  // Authentication
  LOGIN: 'auth.login',
  LOGOUT: 'auth.logout',
  LOGIN_FAILED: 'auth.login_failed',

  // Settings
  SETTINGS_UPDATE: 'settings.update',
  SETTINGS_CREATE: 'settings.create',

  // Users
  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_DELETE: 'user.delete',
  USER_PASSWORD_RESET: 'user.password_reset',

  // Students
  STUDENT_CREATE: 'student.create',
  STUDENT_UPDATE: 'student.update',
  STUDENT_DELETE: 'student.delete',
  STUDENT_IMPORT: 'student.import',

  // Groups
  GROUP_CREATE: 'group.create',
  GROUP_UPDATE: 'group.update',
  GROUP_DELETE: 'group.delete',
  GROUP_STUDENT_ADD: 'group.student_add',
  GROUP_STUDENT_REMOVE: 'group.student_remove',

  // Sessions
  SESSION_START: 'session.start',
  SESSION_END: 'session.end',

  // Remote Control
  REMOTE_LOCK: 'remote.lock',
  REMOTE_UNLOCK: 'remote.unlock',
  REMOTE_OPEN_TAB: 'remote.open_tab',
  REMOTE_CLOSE_TABS: 'remote.close_tabs',
  REMOTE_FLIGHT_PATH: 'remote.apply_flight_path',
  REMOTE_BLOCK_LIST: 'remote.apply_block_list',
  REMOTE_ATTENTION: 'remote.attention_mode',
  REMOTE_TIMER: 'remote.timer',
  REMOTE_POLL: 'remote.poll',

  // Flight Paths & Block Lists
  FLIGHT_PATH_CREATE: 'flight_path.create',
  FLIGHT_PATH_UPDATE: 'flight_path.update',
  FLIGHT_PATH_DELETE: 'flight_path.delete',
  BLOCK_LIST_CREATE: 'block_list.create',
  BLOCK_LIST_UPDATE: 'block_list.update',
  BLOCK_LIST_DELETE: 'block_list.delete',

  // School Admin
  SCHOOL_CREATE: 'school.create',
  SCHOOL_UPDATE: 'school.update',
  SCHOOL_DELETE: 'school.delete',
} as const;

export type AuditActionType = (typeof AuditAction)[keyof typeof AuditAction];

interface AuditContext {
  userId: string;
  userEmail?: string;
  userRole?: string;
  schoolId: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Extract audit context from Express request
 */
export function getAuditContext(req: Request): AuditContext | null {
  const schoolId = (req as any).session?.schoolId || (req as any).res?.locals?.schoolId;
  const userId = (req as any).session?.userId;

  if (!schoolId || !userId) {
    return null;
  }

  return {
    userId,
    userRole: (req as any).session?.role,
    schoolId,
    ipAddress: req.ip || req.connection?.remoteAddress,
    userAgent: req.get('user-agent'),
  };
}

/**
 * Log an audit event
 */
export async function logAudit(
  context: AuditContext,
  action: AuditActionType | string,
  options?: {
    entityType?: string;
    entityId?: string;
    entityName?: string;
    changes?: { old?: any; new?: any };
    metadata?: Record<string, any>;
  }
): Promise<void> {
  try {
    const log: InsertAuditLog = {
      schoolId: context.schoolId,
      userId: context.userId,
      userEmail: context.userEmail,
      userRole: context.userRole,
      action,
      entityType: options?.entityType,
      entityId: options?.entityId,
      entityName: options?.entityName,
      changes: options?.changes,
      metadata: {
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        ...options?.metadata,
      },
    };

    await storage.createAuditLog(log);
  } catch (error) {
    // Don't throw - audit logging should not break the main operation
    console.error('[Audit] Failed to log audit event:', error);
  }
}

/**
 * Helper to log audit from Express request
 */
export async function logAuditFromRequest(
  req: Request,
  action: AuditActionType | string,
  options?: {
    entityType?: string;
    entityId?: string;
    entityName?: string;
    changes?: { old?: any; new?: any };
    metadata?: Record<string, any>;
    userEmail?: string;
  }
): Promise<void> {
  const context = getAuditContext(req);
  if (!context) {
    console.warn('[Audit] Cannot log - no audit context available');
    return;
  }

  if (options?.userEmail) {
    context.userEmail = options.userEmail;
  }

  await logAudit(context, action, options);
}

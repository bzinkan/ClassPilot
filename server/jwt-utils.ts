import jwt from 'jsonwebtoken';
import { getRequiredSecret } from './util/env';

// JWT Secret - MUST be set in environment variables for production
const JWT_SECRET = getRequiredSecret('STUDENT_TOKEN_SECRET', {
  minBytes: 32,
  devLogMessage: '[auth] Generated dev STUDENT_TOKEN_SECRET',
});

// Token expiration: 7 days (industry standard for classroom apps)
const TOKEN_EXPIRY = '7d';

/**
 * JWT Payload for student tokens
 * Contains everything needed to identify a student and their device
 */
export interface StudentTokenPayload {
  studentId: string;
  deviceId: string;
  schoolId: string;
  studentEmail?: string; // Optional: include email for audit trails
  iat?: number; // Issued at (auto-added by jwt.sign)
  exp?: number; // Expiration (auto-added by jwt.sign)
}

/**
 * Create a signed JWT token for a student-device pair
 * This is the ONLY way extensions should authenticate
 */
export function createStudentToken(payload: {
  studentId: string;
  deviceId: string;
  schoolId: string;
  studentEmail?: string;
}): string {
  const tokenPayload: StudentTokenPayload = {
    studentId: payload.studentId,
    deviceId: payload.deviceId,
    schoolId: payload.schoolId,
    studentEmail: payload.studentEmail,
  };

  return jwt.sign(tokenPayload, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: TOKEN_EXPIRY,
  });
}

/**
 * Verify and decode a student token
 * Returns the decoded payload if valid, throws error if invalid/expired
 */
export function verifyStudentToken(token: string): StudentTokenPayload {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
    }) as StudentTokenPayload;
    
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new TokenExpiredError('Student token has expired');
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new InvalidTokenError('Invalid student token');
    }
    throw error;
  }
}

/**
 * Decode token without verification (for debugging only)
 */
export function decodeStudentToken(token: string): StudentTokenPayload | null {
  try {
    return jwt.decode(token) as StudentTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Custom error classes for JWT validation
 */
export class TokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

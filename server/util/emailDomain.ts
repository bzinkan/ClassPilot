import { normalizeEmail as baseNormalizeEmail } from "@shared/schema";

export class EmailDomainError extends Error {
  status = 400;
}

export function normalizeEmail(email: string): string {
  return baseNormalizeEmail(email);
}

export function getEmailDomain(email: string): string | null {
  const normalized = normalizeEmail(email);
  const atIndex = normalized.indexOf("@");
  if (atIndex === -1) {
    return null;
  }
  return normalized.slice(atIndex + 1);
}

export function assertEmailMatchesDomain(email: string, allowedDomain: string): void {
  const normalizedAllowed = allowedDomain.trim().toLowerCase().replace(/^@/, "");
  const emailDomain = getEmailDomain(email);

  if (!emailDomain) {
    throw new EmailDomainError("Invalid email address");
  }

  if (emailDomain.toLowerCase() !== normalizedAllowed) {
    throw new EmailDomainError(`Email domain must match ${normalizedAllowed}`);
  }
}

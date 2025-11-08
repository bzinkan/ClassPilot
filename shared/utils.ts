import type { Heartbeat } from './schema';

export interface URLSession {
  url: string;
  title: string;
  favicon?: string;
  startTime: Date;
  endTime: Date;
  durationSeconds: number;
  heartbeatCount: number;
}

/**
 * Calculate time spent on each URL from heartbeat data.
 * Groups consecutive heartbeats for the same URL and calculates duration.
 * 
 * @param heartbeats - Array of heartbeat records (will be sorted by timestamp)
 * @param heartbeatIntervalSeconds - Expected interval between heartbeats (default: 10)
 * @returns Array of URL sessions with duration information
 */
export function calculateURLSessions(
  heartbeats: Heartbeat[], 
  heartbeatIntervalSeconds: number = 10
): URLSession[] {
  if (heartbeats.length === 0) return [];

  // Sort by timestamp (oldest first)
  const sorted = [...heartbeats].sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const sessions: URLSession[] = [];
  let currentSession: URLSession | null = null;

  for (let i = 0; i < sorted.length; i++) {
    const heartbeat = sorted[i];
    const currentTime = new Date(heartbeat.timestamp);
    const currentUrl = heartbeat.activeTabUrl;

    if (!currentSession || currentSession.url !== currentUrl) {
      // Start new session
      if (currentSession) {
        sessions.push(currentSession);
      }

      currentSession = {
        url: currentUrl,
        title: heartbeat.activeTabTitle,
        favicon: heartbeat.favicon || undefined,
        startTime: currentTime,
        endTime: currentTime,
        durationSeconds: heartbeatIntervalSeconds, // Initial duration
        heartbeatCount: 1,
      };
    } else {
      // Continue existing session
      currentSession.endTime = currentTime;
      currentSession.heartbeatCount++;
      
      // Update title/favicon to most recent
      currentSession.title = heartbeat.activeTabTitle;
      if (heartbeat.favicon) {
        currentSession.favicon = heartbeat.favicon;
      }

      // Calculate duration: time span + one interval for the final heartbeat
      const timeSpanSeconds = Math.floor(
        (currentTime.getTime() - currentSession.startTime.getTime()) / 1000
      );
      currentSession.durationSeconds = timeSpanSeconds + heartbeatIntervalSeconds;
    }
  }

  // Add the last session
  if (currentSession) {
    sessions.push(currentSession);
  }

  return sessions;
}

/**
 * Format duration in seconds to human-readable format
 * @param seconds - Duration in seconds
 * @returns Formatted string like "5m 30s" or "1h 15m"
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 && hours === 0) parts.push(`${secs}s`); // Only show seconds if less than 1 hour

  return parts.join(' ');
}

/**
 * Group URL sessions by device ID
 * @param heartbeats - Array of heartbeat records
 * @returns Map of deviceId to array of URL sessions
 */
export function groupSessionsByDevice(heartbeats: Heartbeat[]): Map<string, URLSession[]> {
  const deviceHeartbeats = new Map<string, Heartbeat[]>();

  // Group heartbeats by device
  for (const heartbeat of heartbeats) {
    if (!deviceHeartbeats.has(heartbeat.deviceId)) {
      deviceHeartbeats.set(heartbeat.deviceId, []);
    }
    deviceHeartbeats.get(heartbeat.deviceId)!.push(heartbeat);
  }

  // Calculate sessions for each device
  const deviceSessions = new Map<string, URLSession[]>();
  Array.from(deviceHeartbeats.entries()).forEach(([deviceId, beats]) => {
    deviceSessions.set(deviceId, calculateURLSessions(beats));
  });

  return deviceSessions;
}

/**
 * Check if the current time is within tracking hours and days, using the school's timezone.
 * This ensures consistent enforcement across client and server regardless of where they're hosted.
 * 
 * @param enableTrackingHours - Whether tracking hours feature is enabled
 * @param trackingStartTime - Start time in HH:MM format (e.g., "08:00")
 * @param trackingEndTime - End time in HH:MM format (e.g., "15:00")
 * @param schoolTimezone - School timezone in IANA format (e.g., "America/New_York")
 * @param trackingDays - Array of day names when tracking is active (e.g., ["Monday", "Tuesday", ...])
 * @returns true if currently within tracking hours AND days (or if feature disabled), false otherwise
 */
export function isWithinTrackingHours(
  enableTrackingHours: boolean | null | undefined,
  trackingStartTime: string | null | undefined,
  trackingEndTime: string | null | undefined,
  schoolTimezone: string | null | undefined,
  trackingDays: string[] | null | undefined
): boolean {
  // If tracking hours not enabled, always allow tracking
  if (!enableTrackingHours) {
    return true;
  }

  // Defaults
  const startTime = trackingStartTime || "00:00";
  const endTime = trackingEndTime || "23:59";
  const timezone = schoolTimezone || "America/New_York";
  const activeDays = trackingDays || ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

  try {
    const now = new Date();
    
    // Get current day of week in school's timezone
    const schoolDayName = now.toLocaleString("en-US", { 
      timeZone: timezone,
      weekday: 'long'
    });
    
    // Check if current day is in the list of tracking days
    if (!activeDays.includes(schoolDayName)) {
      return false;
    }
    
    // Get current time in school's timezone
    const schoolTimeString = now.toLocaleString("en-US", { 
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });
    
    // Extract HH:MM from the formatted string
    const currentTime = schoolTimeString.split(', ')[1] || schoolTimeString;

    // Compare times as strings (HH:MM format)
    return currentTime >= startTime && currentTime <= endTime;
  } catch (error) {
    console.error("Error checking tracking hours:", error);
    // On error, default to allowing tracking (fail open for usability)
    return true;
  }
}

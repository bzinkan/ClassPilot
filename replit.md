# ClassPilot - Teacher Dashboard & Chrome Extension

## Overview
ClassPilot is a privacy-aware classroom monitoring system for educational settings. It's a full-stack web application with a teacher dashboard and a Chrome Extension, designed for transparent monitoring of student activity on managed Chromebooks. The system prioritizes privacy through clear disclosure banners and opt-in screen sharing, offering real-time activity tracking, class roster management, and robust data retention controls. ClassPilot aims for FERPA/COPPA compliance by collecting minimal, essential data, supporting shared Chromebook environments, and providing comprehensive remote classroom control features. Its goal is to empower educators with effective digital classroom management while safeguarding student privacy and adhering to educational regulations.

## Recent Changes (Nov 12, 2025)

### Screen Sharing Fixes
**Problem**: Teachers couldn't view student screens. Screen share dialog wouldn't appear, and when it did (for admins), video was black.

**Fixes Implemented**:
1. **Permission System** - Added class-based permission checking. Teachers can now view students assigned to their classes via "Assign Students to Class" feature. Permission check validates: (1) direct assignment, (2) student in teacher's group/class, or (3) active session.

2. **Video Playback** - Fixed black video by adding explicit `video.play()` calls after DOM reparenting. Video element now restarts playback when moved from tile to portal and back.

3. **TypeScript Safety** - Created `StudentUpdateFields` type for proper student update typing, fixed offline student device handling, and added validation guards.

## User Preferences
I prefer detailed explanations.
Do not make changes to the folder `Z`.
Do not make changes to the file `Y`.
I want iterative development.
Ask before making major changes.
I prefer simple language.
I like functional programming.

## System Architecture

### UI/UX Decisions
The frontend uses React, TypeScript, and Tailwind CSS, supporting dark/light modes. The dashboard features a grid-based, alphabetical display of student activity with color-coded statuses (on-task, off-task, idle, offline). Detailed student info is in a drawer, and administration is in a dedicated interface. Roster management is a separate page. The dashboard employs a 3-row design for grade filtering, student targeting, and color-coded action buttons for tab, screen, and domain management. All remote control commands support per-student targeting with UI indicators.

### Technical Implementations
The system is a full-stack application:
-   **Frontend**: React, TypeScript, TanStack Query for state, WebSockets for real-time updates.
-   **Backend**: Express and Node.js provide RESTful APIs for authentication, device registration, heartbeats, event logging, student data, WebRTC signaling, and school settings. It includes role-based access control, bcrypt, session management, rate limiting, and CSRF protection.
-   **Real-time Communication**: WebSockets manage live updates, and WebRTC facilitates screen sharing, both with automatic reconnection.
-   **Chrome Extension**: A Manifest V3 extension with a reliable service worker using `chrome.alarms` for persistent heartbeats. It includes automatic student detection via Chrome Identity API and `chrome.webNavigation` for browsing activity tracking.
-   **Email-First, Multi-Device Architecture**: Students are uniquely identified by `(schoolId, emailLc)`, enabling many-to-many device relationships via a `student_devices` junction table. This supports shared Chromebooks and email-based student lookup and upsert operations. The extension registers on every startup with deviceId and studentEmail, ensuring fresh student-device linkage. Heartbeats also include `studentId` and `studentEmail` for resilience. Placeholder students (pending_email) are created when email is unavailable and reconciled automatically when email becomes known.
-   **Student Status System**: The `studentStatus` column ('active' | 'pending_email') helps filter students for teacher dashboards.
-   **Daily Reset System for Shared Chromebooks**: Student-device associations expire after 24 hours (`lastSeenAt` timestamp) and are cleaned up by a scheduled job.
-   **Student Monitoring**: Collects tab titles, URLs, timestamps, and favicons every 10 seconds, with real-time alerts for domain blocklist violations. Classifies students as Online, Idle, or Offline.
-   **Camera Usage Monitoring**: Detects camera activation as off-task behavior.
-   **Live Screen Viewing**: Real-time WebRTC screen capture with silent tab capture on managed Chromebooks and advanced video controls.
-   **Website Duration Tracking**: Calculates time spent on websites.
-   **Student Data Analytics**: Interactive pie chart visualization of website visit durations.
-   **Student History Tracking**: Tabbed interface in the student detail drawer for "Screens" (current activity) and "History" (filterable timeline).
-   **Admin System**: Manages teacher accounts.
-   **Data Retention**: Configurable data retention with automatic cleanup and Excel export.
-   **School Tracking Hours**: Privacy-focused monitoring times configured by administrators based on school timezone.
-   **Remote Classroom Control**: Features include Open Tab, Close Tabs, Lock/Unlock Screen, Apply Flight Paths, Student Groups, and Tab Limiting, all with per-student targeting.
-   **Teacher-Specific Settings (Multi-Tenancy)**: Supports multiple teachers with isolated resources (Flight Paths, Student Groups, settings) and student assignments.
-   **Session-Based Classroom Management**: Teachers create and manage class sessions to filter the dashboard view, showing all students in a session even if offline.
-   **Admin Class Management**: Administrators can create and manage official class rosters for teachers with CRUD operations and grade-based browsing.
-   **CSV/Excel Bulk Student Import**: Administrators can import students via CSV/Excel, matching by email, assigning to classes, and receiving detailed import results. Supports flexible column names and provides a template.
-   **Single Student Creation**: Administrators can create individual students with required name, email, and grade level, with optional class assignment.
-   **Grade-Based Organization**: All student creation methods require grade level selection, influencing filtering and roster updates.
-   **Privacy-First**: Transparent monitoring, explicit consent for screen sharing, minimal data collection.
-   **Scalability**: Utilizes PostgreSQL with Drizzle ORM.
-   **Deployment**: Designed for production, supporting Google Admin force-install.
-   **IP Allowlist**: Optional IP-based access control for the teacher dashboard.
-   **API Design**: Clear separation of concerns for student, device, and active student management.
-   **Cache Invalidation**: Standardized pattern using `invalidateStudentCaches()` ensures all views are synchronized.
-   **CASCADE Delete Pattern**: `deleteStudent()` function implements comprehensive cleanup of all related data to prevent orphaned records.

## External Dependencies
-   **Database**: PostgreSQL (Neon-backed)
-   **ORM**: Drizzle ORM
-   **Frontend Libraries**: React, TypeScript, TanStack Query, Tailwind CSS, Shadcn UI
-   **Backend Libraries**: Express, Node.js, `ws` (WebSocket library), bcrypt
-   **APIs**: WebRTC
# ClassPilot - Teacher Dashboard & Chrome Extension

## Overview
ClassPilot is a privacy-aware classroom monitoring system designed for educational settings. This full-stack web application, comprising a teacher dashboard and a Chrome Extension, enables transparent monitoring of student activity on managed Chromebooks. It prioritizes privacy with clear disclosure banners and opt-in screen sharing, provides real-time activity tracking, class roster management, and robust data retention controls. The system aims for FERPA/COPPA compliance by collecting minimal, essential data, supporting shared Chromebook environments, and offering comprehensive remote classroom control features. The project's ambition is to provide educators with effective digital classroom management while upholding student privacy and complying with educational regulations.

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
The frontend utilizes React and TypeScript with Tailwind CSS for styling, supporting both dark and light modes. The dashboard features a grid-based layout for real-time student activity, with student tiles sorted alphabetically and color-coded statuses (green: on-task, red: off-task, yellow: idle, grey: offline). Detailed student information is accessible via a drawer, and administration functionalities are in a dedicated interface. Roster management is a separate page for improved user experience. The dashboard employs a 3-row design for grade filtering, student targeting controls, and color-coded action buttons for tab management, screen control, and domain restrictions. All remote control commands support per-student targeting via checkboxes, with UI indicators showing the targeting scope.

### Technical Implementations
The system is built with a full-stack architecture:
-   **Frontend**: React, TypeScript, TanStack Query for server state management, and WebSockets for real-time updates.
-   **Backend**: Express and Node.js provide RESTful APIs for authentication, device registration, heartbeats, event logging, student data, WebRTC signaling, and school settings. It incorporates robust security measures including role-based access control, bcrypt, session management, rate limiting, and CSRF protection.
-   **Real-time Communication**: A WebSocket server handles live updates and WebRTC facilitates screen sharing, both with automatic reconnection logic.
-   **WebRTC Live View Signaling**: A simplified signaling flow ensures reliable screen sharing. The Chrome Extension uses an MV3-compliant offscreen document for WebRTC.
-   **Chrome Extension**: A Manifest V3 extension with a reliable background service worker using `chrome.alarms` for persistent heartbeat monitoring. It includes production-ready configuration, automatic student detection via the Chrome Identity API, and `chrome.webNavigation` for tracking browsing activity.
-   **Email-First, Multi-Device Architecture**: Students are uniquely identified by `(schoolId, emailLc)` - a composite key that enables true email-first architecture with case-insensitive matching. The `emailLc` column is a generated column created via `lower(trim(email))` with a unique constraint preventing duplicate students per school. This architecture supports:
    1. **Many-to-Many Device Relationships**: The `student_devices` junction table tracks which devices a student has used, allowing one student to appear on multiple devices (shared Chromebooks, device switches). FK constraints with CASCADE delete ensure referential integrity. The deprecated `students.deviceId` column is now nullable and should not be used.
    2. **Email-Based Student Lookup**: The `getStudentByEmail(schoolId, email)` method normalizes emails and queries by `(schoolId, emailLc)`, ensuring consistent student matching regardless of email case variations.
    3. **Upsert-Based Student Creation**: The `upsertStudent(schoolId, email, name, grade)` method creates new students or updates existing ones based on email lookup, preventing duplicates and enabling seamless student data updates.
    4. **Device Linkage Methods**: `addStudentDevice(studentId, deviceId)`, `getStudentDevices(studentId)`, and `getDeviceStudents(deviceId)` manage the many-to-many relationships via the junction table.
    5. **Chrome Extension Registration Flow**: The extension calls `/api/register-student` on EVERY startup/wake-up (not just once), sending both `deviceId` and `studentEmail`. The server upserts the student by email and adds the device to their device list, ensuring fresh student-device linkage after Chrome storage resets or device switches.
    6. **Resilient Heartbeats**: Heartbeats include BOTH `studentId` AND `studentEmail` to handle Chrome storage resets, device switches, and shared Chromebook scenarios. The `heartbeats` table includes a `studentEmail` column for email-first reconciliation.
    7. **Placeholder Student Reconciliation**: When Chrome Extension registers without email (missing `identity.email` permission), the system creates a `pending_email` placeholder student (marked with `studentStatus='pending_email'`). When email becomes available later, the reconciliation logic automatically promotes the placeholder to an active student or deletes it if a real student with that email already exists. CSV imports also create placeholder students with `pending-{email}` device IDs that are automatically reconciled on first extension login.
    8. **Student Status System**: The `studentStatus` column ('active' | 'pending_email') enables filtering pending students from teacher dashboards while keeping them in an admin-only queue for email assignment. Automatic promotion occurs when the Chrome Extension provides email credentials.
    9. **CASCADE Delete Pattern**: Both `deleteStudent` and `deleteDevice` properly clean up the junction table (via FK constraints), composite status keys (studentId-deviceId), and activeStudents entries for all affected devices, preventing orphaned records.
-   **Shared Chromebook Support**: Full support for multiple students on the same device, with automatic student detection and student-specific activity tracking.
-   **Student Monitoring**: Collects tab titles, URLs, timestamps, and favicons every 10 seconds, with real-time alerts for domain blocklist violations. Students are classified as Online, Idle, or Offline.
-   **Camera Usage Monitoring**: Detects camera activation via the Chrome extension, treating it as off-task behavior.
-   **Live Screen Viewing**: Real-time screen capture using WebRTC with silent tab capture on managed Chromebooks and advanced video controls (zoom, screenshot, recording, fullscreen, picture-in-picture).
-   **Website Duration Tracking**: Calculates and displays time spent on websites by grouping consecutive heartbeats.
-   **Flight Path Analytics**: Provides insights into active Flight Paths for each student.
-   **Student Data Analytics**: Interactive pie chart visualization of website visit durations for the past 24 hours, viewable for the whole class or individual students.
-   **Student History Tracking**: Comprehensive tabbed interface in the student detail drawer, including "Screens" (current activity and recent browsing sessions), and "History" (filterable activity timeline with grouped browsing sessions).
-   **Admin System**: Manages teacher accounts.
-   **Data Retention**: Configurable data retention with automatic cleanup and Excel export.
-   **School Tracking Hours**: Privacy-focused feature allowing administrators to configure monitoring times based on school timezone and specific days of the week, with backend validation and a dashboard indicator.
-   **Remote Classroom Control**: Features include Open Tab, Close Tabs (all or by pattern), Lock Screen (to current URL), Unlock Screen, Apply Flight Paths, Student Groups, and Tab Limiting, all with per-student targeting.
-   **Teacher-Specific Settings (Multi-Tenancy)**: Supports multiple teachers with isolated resources (Flight Paths, Student Groups, settings) and student assignments. Teachers access personal settings to manage Flight Paths, tab limits, and allowed/blocked domains.
-   **Session-Based Classroom Management**: Teachers create class groups/rosters (e.g., "7th Science P3") and start/end daily class sessions to filter dashboard view. When a session is active, ALL students in the session's group roster appear on the dashboard—including offline students who haven't connected yet. Offline students display with grey status indicators and placeholder data until their Chrome Extensions send first heartbeat. This enables teachers to immediately see their complete class roster upon starting a session, rather than waiting for devices to connect. Admin migration tool converts existing teacher-student assignments to default groups. Admin session monitor provides school-wide visibility of all active class sessions.
-   **Admin Class Management**: Administrators can create official class rosters for teachers through a dedicated interface. Features include grade-based browsing, class creation with teacher assignment, bulk student roster assignment, and full CRUD operations on admin-created classes. Classes are typed (admin_class vs teacher_created) to prevent accidental modification of teacher-owned groups.
-   **CSV/Excel Bulk Student Import**: Administrators can upload CSV or Excel files to import multiple students at once. Before upload, a required grade level dropdown (K-12) must be selected, which applies to all students in the file. The system matches students by email (creating new records or updating existing ones), assigns them to classes by name, and provides detailed import results with success/error counts. Students imported via CSV/Excel are pre-created with placeholder device IDs, and the Chrome Extension automatically recognizes them on first login via email matching. Supports flexible CSV column names (Email/email, Name/name, Class/class) and provides a downloadable template. Import results display created/updated/assigned counts, plus detailed error and warning lists for troubleshooting.
-   **Single Student Creation**: Administrators can create individual students through a dedicated dialog with required fields for name, email, and grade level (K-12 dropdown). Optional class assignment is available during creation. Grade levels are enforced via predefined dropdown options to ensure data consistency.
-   **Grade-Based Organization**: All student creation methods (bulk import and single creation) require grade level selection. Students automatically appear in grade filter options throughout the admin interface, and roster updates are reflected immediately via cache invalidation.

### System Design Choices
-   **Privacy-First**: Transparent monitoring, explicit consent for screen sharing, minimal data collection.
-   **Scalability**: Utilizes PostgreSQL (Neon-backed) with Drizzle ORM and a normalized schema.
-   **Deployment**: Designed for production, supporting Google Admin force-install of the Chrome Extension.
-   **IP Allowlist**: Optional IP-based access control for the teacher dashboard.
-   **API Design**: Clear separation of concerns with distinct endpoints for student, device, and active student management.
-   **Cache Invalidation**: Standardized pattern using `invalidateStudentCaches()` helper in `client/src/lib/cacheUtils.ts` ensures all views (Dashboard, Roster, Admin) stay synchronized when student data changes. All student mutations (create, edit, delete, assign, bulk import, cleanup) use this shared helper to invalidate `/api/roster/students`, `/api/students`, `/api/groups`, `/api/admin/teacher-students`, and `/api/teacher/groups`.
-   **CASCADE Delete Pattern**: The `deleteStudent()` function in `server/storage.ts` implements comprehensive CASCADE cleanup to prevent orphaned records and ghost student tiles. Both MemStorage and DatabaseStorage delete all related data including: plain and composite studentStatus keys (studentId and studentId-deviceId), activeStudents entries, heartbeats, events, messages (by toStudentId), checkIns, groupStudents/teacherStudents relationships, and StudentGroups.studentIds arrays. This ensures complete data cleanup when students are deleted, preventing stale UI references.

## External Dependencies
-   **Database**: PostgreSQL (Neon-backed)
-   **ORM**: Drizzle ORM
-   **Frontend Libraries**: React, TypeScript, TanStack Query, Tailwind CSS, Shadcn UI
-   **Backend Libraries**: Express, Node.js, `ws` (WebSocket library), bcrypt
-   **APIs**: WebRTC
# ClassPilot - Teacher Dashboard & Chrome Extension

> **Development history, not a production runbook.** SchoolPilot is the sole
> production API and teacher web app. Deploy from the SchoolPilot repository's
> guarded `CLAUDE.md` and `docs/CLASSPILOT_2_7_1_RELEASE.md`; this repository's
> production output is only the verified ClassPilot extension archive.

## Overview
ClassPilot is a privacy-aware classroom monitoring system for educational settings. This full-stack web application, consisting of a teacher dashboard and a Chrome Extension, enables transparent monitoring of student activity on managed Chromebooks. It prioritizes privacy with disclosure banners, class-bound tracking-window screenshots (with gap/student-session pixels discarded on receipt), exact safety captures, and authorized temporary Live View streams that are not recorded by the extension or SchoolPilot servers; an authorized teacher can explicitly save a local recording or still image governed by school policy. It provides real-time activity tracking, class roster management, and robust data retention controls. The system is designed to support schools' FERPA/COPPA responsibilities by limiting collection to documented educational purposes, supporting shared Chromebook environments, and offering comprehensive remote classroom control features.

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
The frontend uses React, TypeScript, and Tailwind CSS, supporting dark/light modes. The dashboard features a grid-based layout for real-time student activity, with alphabetical sorting and color-coded statuses (on-task, off-task, idle, offline). Detailed student information is via a drawer, and administration is in a dedicated interface. Roster management is a separate page. The dashboard employs a 3-row design for grade filtering, student targeting controls, and color-coded action buttons for tab management, screen control, and domain restrictions. Remote control commands support per-student targeting with UI indicators.

### Technical Implementations
The system is built with a full-stack architecture:
-   **Frontend**: React, TypeScript, TanStack Query, WebSockets for real-time updates.
-   **Backend**: Express and Node.js provide RESTful APIs for authentication, device registration, heartbeats, event logging, student data, WebRTC signaling, and school settings, with security measures like role-based access control, bcrypt, session management, rate limiting, and CSRF protection.
-   **Real-time Communication**: A WebSocket server handles live updates, and WebRTC facilitates screen sharing, both with automatic reconnection.
-   **WebRTC Live View Signaling**: Simplified signaling for reliable screen sharing; Chrome Extension uses an MV3-compliant offscreen document with graceful failure handling for invalid signaling states (attempts recovery instead of cleanup loop). **Authorization**: Live View permissions follow dashboard visibility - if a teacher can see a student tile, they can use Live View. Dashboard visibility already enforces role-based access control.
-   **Chrome Extension**: Manifest V3 extension with a reliable background service worker using `chrome.alarms` for persistent heartbeat monitoring, production-ready configuration, automatic student detection via Chrome Identity API, and `chrome.webNavigation` for browsing activity tracking.
-   **JWT Authentication System**: Industry-standard HS256-signed JSON Web Tokens authenticate student devices. Extension receives a 7-day studentToken on registration, stored in chrome.storage.local and sent with every heartbeat. Backend verifies token signature and expiration, extracting tamper-proof studentId, deviceId, and schoolId. Handles token expiration (401) and invalid tokens (403) with automatic re-registration. Provides gradual migration path with legacy fallback for backward compatibility.
-   **Email-Based Student Recognition**: Students are identified by email across devices for automatic record matching and device ID updates.
-   **Shared Chromebook Support**: Supports multiple students on the same device with automatic detection and student-specific tracking.
-   **Session-Based Device Tracking**: Device-first identification architecture with a `student_sessions` table tracking "Student X on Device Y RIGHT NOW." Transactional swap logic ensures one active session per student and device. Background jobs manage session expiration.
-   **Student Monitoring**: Collects tab titles, URLs, timestamps, and favicons every 10 seconds, with real-time alerts for domain blocklist violations. Classifies students as Online, Idle, or Offline.
-   **All-Tabs Tracking**: Chrome Extension sends a bounded open-tab snapshot for authorized classroom controls. Exact tab references are identity-bound, and a limited local snapshot may persist across service-worker restarts; SchoolPilot retention follows the configured school policy.
-   **Camera Usage Monitoring**: Detects camera activation via the Chrome extension, treating it as off-task behavior.
-   **Live Screen Viewing**: Real-time screen capture using WebRTC with silent tab capture on managed Chromebooks and advanced video controls.
-   **Website Duration Tracking**: Calculates and displays time spent on websites.
-   **Flight Path Analytics**: Provides insights into active Flight Paths for each student.
-   **Student Data Analytics**: Interactive pie chart visualization of website visit durations.
-   **Student History Tracking**: Comprehensive tabbed interface in the student detail drawer, including "Screens" (current activity and recent browsing sessions) and "History" (filterable activity timeline).
-   **Admin System**: Manages teacher accounts.
-   **Data Retention**: Configurable data retention with automatic cleanup and CSV export.
-   **School Tracking Hours**: Privacy-focused feature allowing administrators to configure monitoring times.
-   **Remote Classroom Control**: Features include Open Tab, Close Tabs, Lock Screen, Unlock Screen, Apply Flight Paths, Student Groups, and Tab Limiting, all with per-student targeting.
-   **Teacher-Specific Settings (Multi-Tenancy)**: Supports multiple teachers with isolated resources (Flight Paths, Student Groups, settings) and student assignments.
-   **Session-Based Classroom Management**: Teachers create class groups/rosters and start/end daily class sessions to filter the dashboard view. All students in an active session's roster appear, including offline students.
-   **Admin Class Management**: Administrators can create official class rosters, assign teachers, and manage students with full CRUD operations.
-   **CSV Bulk Student Import**: Administrators can upload CSV files to import multiple students, matching by email, assigning to classes, and providing detailed import results.
-   **Admin Student Roster Management**: Dedicated `/students` page for admin-only student roster management, including CSV bulk import, dynamic grade filtering, student table view, and edit/delete functionalities.

### System Design Choices
-   **Privacy-First**: Transparent school-managed monitoring, authorized temporary Live View, purpose-limited data processing, and configurable retention.
-   **Scalability**: Utilizes PostgreSQL (Neon-backed) with Drizzle ORM.
-   **Deployment**: Designed for production, supporting Google Admin force-install of the Chrome Extension.
-   **IP Allowlist**: Optional IP-based access control for the teacher dashboard.
-   **API Design**: Clear separation of concerns with distinct endpoints for student, device, and active student management.

## External Dependencies
-   **Database**: PostgreSQL (Neon-backed)
-   **ORM**: Drizzle ORM
-   **Frontend Libraries**: React, TypeScript, TanStack Query, Tailwind CSS, Shadcn UI
-   **Backend Libraries**: Express, Node.js, `ws` (WebSocket library), bcrypt
-   **APIs**: WebRTC

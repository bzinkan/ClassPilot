# ClassPilot - Teacher Dashboard & Chrome Extension

## Overview
ClassPilot is a privacy-aware classroom monitoring system designed for educational settings. This full-stack web application, consisting of a teacher dashboard and a Chrome Extension, enables transparent monitoring of student activity on managed Chromebooks. It prioritizes privacy with clear disclosure banners and opt-in screen sharing, provides real-time activity tracking, class roster management, and robust data retention controls. The system aims for FERPA/COPPA compliance by collecting minimal, essential data, supporting shared Chromebook environments, and offering comprehensive remote classroom control features.

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
The frontend uses React and TypeScript with Tailwind CSS for styling, supporting dark/light modes. The dashboard features a grid-based layout displaying student activity in real-time. Student tiles are sorted alphabetically by last name and maintain consistent visual indicators (colored borders/shadows) based on their status: green for on-task, red for off-task, yellow for idle, and grey for offline. Detailed student information is available via a drawer, and admin functionalities are in a dedicated interface. Roster management is a separate page for improved UX.

**Dashboard Layout (3-Row Design)**:
- **Row 1**: Grade filter tabs on the left (All Grades, Kindergarten, 5th, etc.) with Student Data analytics button positioned on the right for quick access to pie chart visualizations.
- **Row 2**: Search bar on the left with per-student targeting controls on the right (Target badge showing selection count, Select dropdown menu, and Clear Selection button).
- **Row 3**: Color-coded control button groups for visual clarity:
  - **Blue group**: Open Tab and Close Tab (tab management operations)
  - **Amber group**: Lock Screen and Unlock Screen (screen control operations)
  - **Purple group**: Apply Flight Path and Flight Path viewer (domain restriction operations)

**Per-Student Targeting (Completed)**: All remote control commands now support targeting specific students via checkbox selection. Student tiles include checkboxes, and the toolbar displays selection count with "Select All" and "Clear Selection" buttons. When students are selected, commands apply only to those students; otherwise, they broadcast to all students. The UI clearly indicates targeting scope with "Target: X selected" or "Target: All students" badges.

### Technical Implementations
The system employs a full-stack architecture:
-   **Frontend**: React, TypeScript, TanStack Query for server state management, and WebSockets for real-time updates.
-   **Backend**: Express and Node.js provide RESTful APIs for authentication, device registration, heartbeat updates, event logging, student data, WebRTC signaling, and school settings. It features bulletproof endpoints, global error handlers, and robust security measures like role-based access control, bcrypt, session management, rate limiting, and CSRF protection.
-   **Real-time Communication**: A WebSocket server handles live updates for the dashboard and WebRTC for screen sharing, featuring automatic reconnection logic with exponential backoff for both the dashboard and the Chrome Extension.
-   **WebRTC Live View Signaling**: Simplified signaling flow for reliable screen sharing: (1) Teacher clicks eye icon → sends request-stream + offer immediately, (2) Student starts capture → queues offer if peer connection not ready, (3) Student sends answer → video appears. Eliminates complex peer-ready mechanism and race conditions. Uses MV3-compliant offscreen document for WebRTC in service workers.
-   **Chrome Extension**: A Manifest V3 extension with a reliable background service worker using `chrome.alarms` for persistent heartbeat monitoring. It includes production-ready configuration, automatic student detection via the Chrome Identity API, reliable 10-second heartbeats, exponential backoff for retries, and `chrome.webNavigation` for tracking browsing activity.

### Feature Specifications
-   **Email-Based Student Recognition (Nov 2025)**: Students are now identified by email address across all devices. The system automatically:
    -   Finds existing student records by email when the extension registers
    -   Reuses the same student record when a student switches devices
    -   Updates the deviceId field to track the currently active device
    -   Prevents duplicate student records from being created
    -   Maintains a single student identity across multiple Chromebooks or device changes
-   **Shared Chromebook Support**: Full support for multiple students on the same device, with automatic student detection using Google Workspace email and student-specific activity tracking.
-   **Teacher Dashboard**: Displays live student activity, manages class rosters, and configures data retention. Features customizable grade tabs, in-dashboard grade management, and options to delete students/devices.
-   **Roster Management Page**: A dedicated page for comprehensive device and student assignment management, including grade-level filtering, assigning multiple students per device, editing student and device information, and managing deletions.
-   **Student Monitoring**: Collects tab titles, URLs, timestamps, and favicons every 10 seconds, with real-time alerts for domain blocklist violations. Classifies students as Online, Idle, or Offline based on heartbeat. Displays lock status icon on student tiles.
-   **Camera Usage Monitoring**: Detects when students activate their cameras via the Chrome extension content script. Camera active is automatically treated as off-task behavior, triggering the red border/shadow on student tiles and incrementing the Off-Task Alert count. Camera detection uses a non-intrusive approach by wrapping the MediaDevices getUserMedia API.
-   **Live Screen Viewing**: Real-time screen capture using WebRTC with MV3-compliant offscreen document pattern. Features silent tab capture on managed Chromebooks (no student prompts when Google Admin policies configured), automatic fallback to user picker on non-managed devices, and expandable video view with professional monitoring controls.
-   **Advanced Video Controls**: Expandable live view with zoom controls (0.5x to 3x), screenshot capture (PNG downloads), screen recording (WebM format with duration counter), fullscreen mode, and picture-in-picture support. All captures auto-download to teacher's Downloads folder.
-   **Website Duration Tracking**: Calculates and displays time spent on websites by grouping consecutive heartbeats into sessions.
-   **Flight Path Analytics**: View which Flight Path each student is currently on through a dedicated popup dialog with sortable table showing student names, active Flight Paths (with visual badges), and online/idle/offline status.
-   **Student Data Analytics**: Interactive pie chart visualization showing website visit durations for the past 24 hours. Features include:
    -   Whole class view or individual student drill-down via dropdown selector
    -   Top 10 websites by time spent with color-coded segments
    -   Detailed breakdown list showing exact time (minutes and seconds) spent on each website
    -   Data is calculated from heartbeat intervals, accounting for gaps and session continuity
-   **Student History Tracking**: Comprehensive tabbed interface in student detail drawer featuring:
    -   **Screens Tab**: Current activity and top 5 recent browsing sessions sorted by duration (longest first). Shows session durations, time ranges, and favicons for quick insights into student activity patterns.
    -   **Timeline Tab**: Visual timeline view (placeholder for future implementation)
    -   **History Tab**: Filterable activity timeline with date range picker (calendar-based). Shows grouped browsing sessions (not individual heartbeats) with visual indicators for off-task behavior (Flight Path violations), locked screen status, and camera activity. Sessions display total duration, time ranges, favicons, URLs, and timestamps. Much more readable than showing individual 10-second heartbeats.
    -   **Snapshots Tab**: Screenshot storage and viewing (placeholder for future implementation)
-   **Admin System**: Manages teacher accounts (create, view, delete).
-   **Data Retention**: Configurable data retention with automatic cleanup and Excel export.
-   **Remote Classroom Control**: Includes features like:
    -   **Open Tab**: Teachers can open a specific URL on all student devices or selected students. Dialog prompts for URL input and shows targeting scope (selected students vs. all students).
    -   **Close Tabs**: Teachers can close all tabs or close tabs matching a specific URL pattern (e.g., "youtube.com"). Features a tabbed dialog with "Close All Tabs" and "Close by Pattern" options.
    -   **Lock Screen**: Teachers can instantly lock students to their current URL/domain with a single click. No dialog required - each student is locked to whatever page they're currently viewing and cannot navigate away or open new tabs. Uses special "CURRENT_URL" marker sent to extension.
    -   **Unlock Screen**: Teachers can unlock student screens with a single click. No dialog required - action executes immediately with success notification.
    -   **Apply Flight Paths**: Apply predefined flight paths with multiple allowed domains to restrict student browsing to specific educational websites.
    -   **Student Groups**: Organize students for targeted instruction.
    -   **Tab Limiting**: Configure maximum tabs per student.
    -   **Per-Student Targeting**: All remote commands support targeting specific students via checkbox selection. Dialogs dynamically display whether commands will affect selected students or all students.
-   **Teacher-Specific Settings (Multi-Tenancy)**: Full multi-teacher support with isolated resources and student assignments:
    -   **Teacher-Scoped Resources**: Each teacher has their own Flight Paths, Student Groups, and custom settings (tab limits, allowed/blocked domains)
    -   **Student Assignments**: Students are assigned to specific teachers via the `teacher_students` join table. Teachers only see their assigned students on the dashboard
    -   **Database Schema**: Added `teacherId` columns to `flightPaths` and `studentGroups` tables (nullable for backward compatibility and school-wide defaults). Created `teacher_settings` table for per-teacher configuration and `teacher_students` table for student-teacher relationships
    -   **API Filtering**: All endpoints (`/api/students`, `/api/flight-paths`, `/api/groups`) automatically filter by logged-in teacher ID. School-wide resources (teacherId = null) are visible to all teachers
    -   **Automatic Migration**: On startup, existing students are automatically assigned to the default teacher account, and orphaned flight paths/groups are migrated
    -   **New Endpoints**: Added `/api/teacher/settings`, `/api/teacher/students`, and student assignment endpoints for managing teacher-student relationships
    -   **My Settings Page**: Teachers access their personal settings via a User icon button in the dashboard header. This dedicated page allows teachers to:
        -   Create, edit, and delete their personal Flight Paths with allowed domains
        -   Configure maximum tabs per student
        -   Set a default Flight Path for new students
        -   Define teacher-specific allowed and blocked domains
        -   All settings are teacher-scoped and don't affect other teachers

### System Design Choices
-   **Privacy-First**: Transparent monitoring, explicit consent for screen sharing, no collection of sensitive personal input data.
-   **Scalability**: Utilizes PostgreSQL (Neon-backed) with Drizzle ORM, employing a normalized schema for devices and students.
-   **Deployment**: Designed for production, supporting Google Admin force-install of the Chrome Extension.
-   **IP Allowlist**: Optional IP-based access control for the teacher dashboard.
-   **API Design**: Clear separation of concerns with distinct endpoints for student, device, and active student management.

## External Dependencies
-   **Database**: PostgreSQL (Neon-backed)
-   **ORM**: Drizzle ORM
-   **Frontend Libraries**: React, TypeScript, TanStack Query, Tailwind CSS, Shadcn UI
-   **Backend Libraries**: Express, Node.js, `ws` (WebSocket library), bcrypt
-   **APIs**: WebRTC
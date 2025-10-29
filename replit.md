# ClassPilot - Teacher Dashboard & Chrome Extension

## Overview
A privacy-aware classroom monitoring system designed for educational settings. This full-stack web application, comprising a teacher dashboard and a Chrome Extension, enables teachers to transparently monitor student activity on managed Chromebooks. The system prioritizes privacy with clear disclosure banners and opt-in screen sharing, while also providing real-time activity tracking, class roster management, and robust data retention controls. It aims for FERPA/COPPA compliance by collecting minimal, essential data.

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
The frontend is built with React and TypeScript, using Tailwind CSS for styling with custom design tokens tailored for an educational UI. It supports dark/light mode and features a grid-based dashboard with student tiles for real-time activity display. Detailed student information is accessible via a drawer, and admin functionalities are available through a dedicated interface. The Roster page provides a dedicated view for managing student rosters, separated from system settings for improved UX and organization.

### Technical Implementations
The system uses a full-stack architecture:
- **Frontend**: React, TypeScript, TanStack Query for server state, WebSocket for real-time updates.
- **Backend**: Express and Node.js, providing RESTful APIs for authentication, student device registration, heartbeat updates, event logging, student data retrieval, WebRTC signaling, and school settings management.
  - **Bulletproof Endpoints**: Heartbeat and event logging endpoints never return 500 errors, using async storage with non-blocking database writes and comprehensive error handling
  - **Global Error Handlers**: Process-level handlers for unhandled rejections and uncaught exceptions prevent server crashes
- **Real-time Communication**: A WebSocket server facilitates live updates for teacher dashboards and WebRTC communication for screen sharing.
  - **Automatic Reconnection (NEW)**: Both dashboard and extension implement robust WebSocket reconnection logic
    - Dashboard: Exponential backoff reconnection (1s, 2s, 4s, 8s, 16s... capped at 30s max delay)
    - Extension: Uses chrome.alarms for reconnection (survives service worker termination during idle periods)
    - Visual connection status indicator in dashboard header (Connected/Disconnected badge with animated dot)
    - Proper cleanup prevents memory leaks and state updates on unmounted components
    - React StrictMode compatible with isMountedRef guards
    - Handles network issues, server restarts, and extended idle periods gracefully
- **Security**: Implements role-based access control (admin/teacher), bcrypt for password hashing, Express session management, rate limiting (12kb payload limits), and CSRF protection. An admin middleware protects sensitive routes.
- **Chrome Extension**: A Manifest V3 extension with reliable background service worker using chrome.alarms API for persistent heartbeat monitoring
  - **Production-Ready Configuration (NEW)**: Extension defaults to production server URL (https://classpilot.replit.app) for out-of-the-box deployment
    - Advanced Settings panel in extension popup allows IT admins to configure custom server URLs
    - Supports dev/staging/production environments without reinstalling extension
    - Server URL persists in chrome.storage.local and can be updated dynamically
    - Fresh installs automatically connect to production; no manual configuration needed
  - **Automatic Student Detection**: Uses Chrome Identity API to automatically detect logged-in Chromebook user
    - Eliminates manual student selection - student is auto-identified by their Google Workspace email
    - Uses `chrome.identity.getProfileUserInfo()` to get email and name of logged-in student
    - Auto-registers student on first login with email linked to their profile
    - Extension popup displays auto-detected email prominently
    - Teachers no longer need to manually assign students - system uses Chromebook login credentials
  - **Reliable Heartbeat**: Uses chrome.alarms with manual rescheduling to maintain 10-second intervals (works around 1-minute periodInMinutes minimum)
  - **Exponential Backoff**: Automatic retry logic with jitter prevents server overload during failures
  - **Navigation Tracking**: chrome.webNavigation API captures all URL navigation events including link clicks
  - **Auto-refresh**: Automatically refreshes student's current page after successful registration to apply privacy banner

### Feature Specifications
- **Shared Chromebook Support**: Full support for multiple students using the same Chromebook device across different periods.
  - **Device/Student Separation**: Database schema separates physical devices from student assignments, allowing many-to-one relationships
  - **Automatic Student Detection (NEW)**: Chrome Extension automatically detects which student is logged into the Chromebook using Chrome Identity API
    - No manual selection needed - student email from Google Workspace login is automatically detected
    - Student email stored in database (`studentEmail` field) for unique identification
    - Backend `/api/register-student` endpoint handles email-based auto-registration
    - Seamless workflow: student logs into Chromebook → extension auto-detects → monitoring begins
  - **Active Student Tracking**: System tracks which student is currently using each device via in-memory activeStudents map
  - **Grade Filtering by Active Student**: Dashboard grade filters show students by their individual grade level, not the device's
  - **Heartbeats with studentId**: Each heartbeat includes the active studentId to attribute activity to the correct student
  - **Student-Specific History**: Activity logs and events are tracked per student, enabling accurate monitoring even on shared devices
  - **Roster Multi-Assignment**: Teachers can assign multiple students to a single device from the Roster page
- **Teacher Dashboard**: Displays live student activity (tab title, URL, status), manages class rosters, and configures data retention.
  - **Customizable Grade Tabs**: Teachers can configure which grade levels appear as filter tabs on the dashboard (e.g., "5th, 6th, 7th, 8th" or "9th, 10th, 11th, 12th"). Default includes 5th-12th grades with ordinal suffixes.
  - **In-Dashboard Grade Management (NEW)**: Teachers and admins can add/delete grade levels directly from the dashboard via "Manage Grades" button
    - Add new grades with custom labels (e.g., "K", "Pre-K", "5th")
    - Delete grades with X button (requires at least one grade to remain)
    - Real-time updates to dashboard tabs without navigating to Settings
    - Validates against duplicate grades
  - **Delete Students/Devices**: Teachers can delete individual student assignments or entire devices directly from the dashboard with confirmation dialogs
  - **Roster Navigation**: Dedicated "Roster" button in dashboard header provides quick access to roster management page
  - **Student-First Display**: Dashboard tiles show student names prominently with device information as secondary detail
- **Roster Management Page**: A dedicated page (`/roster`) for comprehensive device and student assignment management:
  - **Grade-Level Filtering (NEW)**: Filter roster by grade level with tabs (All, 5th, 6th, 7th, 8th, etc.) for easier management of large rosters
    - "All Grades" tab shows all students across all devices
    - Individual grade tabs show only students/devices for that specific grade
    - Helpful for schools with 100+ students across multiple grades
  - **View All Devices**: Displays all registered devices grouped by classroom location (classId)
  - **Assign Multiple Students**: Each device shows a nested table of all students assigned to it with "Assign Student" button to add more
  - **Edit Student Information**: Update student name and grade level independently for each student assignment
  - **Edit Device Information**: Update device name and classroom assignment separately from student data
  - **Delete Students**: Remove individual student assignments from devices with confirmation dialogs
  - **Delete Devices**: Remove entire devices (and all student assignments) with warnings about cascading deletion
  - **Nested Table View**: Devices show their assigned students in a clear hierarchical structure
  - **Empty State Handling**: Shows "No students assigned" message for devices without student assignments
  - **Grade Level Tracking**: Each student has their own nullable gradeLevel field
  - **Device Name Support**: Easier Chromebook identification (e.g., "Chromebook 1", "Lab Computer 5")
  - **Persistent Storage**: Database-backed storage with separate devices and students tables ensures data integrity
  - **Automatic Refresh**: Mutations invalidate multiple query keys to keep dashboard and roster synchronized
- **Student Monitoring**: Automatically collects tab titles, URLs, timestamps, and favicons every 10 seconds. Provides real-time alerts for domain blocklist violations.
- **Website Duration Tracking**: 
  - Calculates and displays how long students spend on each website by grouping consecutive heartbeats
  - Student detail drawer shows aggregated sessions with duration (e.g., "5m 30s", "1h 15m") instead of individual heartbeat entries
  - Each session displays website title, URL, duration with time range, and favicon
  - Excel export includes duration columns ("Duration" and "Duration (seconds)") for compliance reporting
  - Uses intelligent session grouping: consecutive heartbeats at the same URL are combined into single sessions
- **Opt-In Screen Sharing**: Students explicitly consent to screen sharing, with clear visual indicators when active.
- **Admin System**: Allows IT administrators to manage teacher accounts (create, view, delete).
- **Data Retention**: Configurable data retention (default 24 hours) with automatic cleanup and Excel export capabilities.
- **Student Status Logic**: Classifies students as Online, Idle, or Offline based on heartbeat timestamps.
- **Allowed Websites & Off-Task Alerts**: Teachers can specify allowed domains in settings. Students navigating away trigger red "Off-Task Alert" status with visual highlighting.

### System Design Choices
- **Privacy-First**: All monitoring is transparent to students with visible indicators and explicit consent for screen sharing. No keystrokes, mic, or camera data are collected.
- **Scalability**: Utilizes PostgreSQL (Neon-backed) with Drizzle ORM for persistent data storage.
  - **Normalized Schema**: Devices and students stored in separate tables with proper foreign key relationships
  - **Efficient Querying**: Separate API endpoints for device operations vs student operations prevent identifier confusion
- **Deployment**: Designed for production readiness, including specific considerations for Google Admin force-install of the Chrome Extension.
- **IP Allowlist**: Basic IP-based access control is available for securing teacher dashboard access.
- **API Design**: Clear separation of concerns with distinct endpoints:
  - `/api/students/:studentId` for student-specific operations (name, grade)
  - `/api/devices/:deviceId` for device-specific operations (device name, classroom)
  - `/api/device/:deviceId/students` for fetching students assigned to a device
  - `/api/device/:deviceId/active-student` for managing active student selection

## External Dependencies
- **Database**: PostgreSQL (Neon-backed)
- **ORM**: Drizzle ORM
- **Frontend Libraries**: React, TypeScript, TanStack Query, Tailwind CSS, Shadcn UI components
- **Backend Libraries**: Express, Node.js, `ws` (WebSocket library), bcrypt
- **APIs**: WebRTC for screen sharing
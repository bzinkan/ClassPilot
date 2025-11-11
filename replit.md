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
-   **Email-Based Student Recognition**: Students are identified by email across devices, allowing for automatic student record matching, device ID updates, and prevention of duplicate student records.
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
-   **CSV Bulk Student Import**: Administrators can upload CSV files to import multiple students at once. The system matches students by email (creating new records or updating existing ones), assigns them to classes by name, and provides detailed import results with success/error counts. Students imported via CSV are pre-created with placeholder device IDs, and the Chrome Extension automatically recognizes them on first login via email matching. Supports flexible CSV column names (Email/email, Name/name, etc.) and provides a downloadable template. Import results display created/updated/assigned counts, plus detailed error and warning lists for troubleshooting.

### System Design Choices
-   **Privacy-First**: Transparent monitoring, explicit consent for screen sharing, minimal data collection.
-   **Scalability**: Utilizes PostgreSQL (Neon-backed) with Drizzle ORM and a normalized schema.
-   **Deployment**: Designed for production, supporting Google Admin force-install of the Chrome Extension.
-   **IP Allowlist**: Optional IP-based access control for the teacher dashboard.
-   **API Design**: Clear separation of concerns with distinct endpoints for student, device, and active student management.

## External Dependencies
-   **Database**: PostgreSQL (Neon-backed)
-   **ORM**: Drizzle ORM
-   **Frontend Libraries**: React, TypeScript, TanStack Query, Tailwind CSS, Shadcn UI
-   **Backend Libraries**: Express, Node.js, `ws` (WebSocket library), bcrypt
-   **APIs**: WebRTC
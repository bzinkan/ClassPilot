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
The frontend uses React and TypeScript with Tailwind CSS for styling, supporting dark/light modes. The dashboard features a grid-based layout displaying student activity in real-time, categorized into Off-Task, On-Task, Idle, and Offline sections. Detailed student information is available via a drawer, and admin functionalities are in a dedicated interface. Roster management is a separate page for improved UX.

**Per-Student Targeting (Completed)**: All remote control commands now support targeting specific students via checkbox selection. Student tiles include checkboxes, and the toolbar displays selection count with "Select All" and "Clear Selection" buttons. When students are selected, commands apply only to those students; otherwise, they broadcast to all students. The UI clearly indicates targeting scope with "Target: X selected" or "Target: All students" badges.

### Technical Implementations
The system employs a full-stack architecture:
-   **Frontend**: React, TypeScript, TanStack Query for server state management, and WebSockets for real-time updates.
-   **Backend**: Express and Node.js provide RESTful APIs for authentication, device registration, heartbeat updates, event logging, student data, WebRTC signaling, and school settings. It features bulletproof endpoints, global error handlers, and robust security measures like role-based access control, bcrypt, session management, rate limiting, and CSRF protection.
-   **Real-time Communication**: A WebSocket server handles live updates for the dashboard and WebRTC for screen sharing, featuring automatic reconnection logic with exponential backoff for both the dashboard and the Chrome Extension.
-   **Chrome Extension**: A Manifest V3 extension with a reliable background service worker using `chrome.alarms` for persistent heartbeat monitoring. It includes production-ready configuration, automatic student detection via the Chrome Identity API, reliable 10-second heartbeats, exponential backoff for retries, and `chrome.webNavigation` for tracking browsing activity.

### Feature Specifications
-   **Shared Chromebook Support**: Full support for multiple students on the same device, with automatic student detection using Google Workspace email and student-specific activity tracking.
-   **Teacher Dashboard**: Displays live student activity, manages class rosters, and configures data retention. Features customizable grade tabs, in-dashboard grade management, and options to delete students/devices.
-   **Roster Management Page**: A dedicated page for comprehensive device and student assignment management, including grade-level filtering, assigning multiple students per device, editing student and device information, and managing deletions.
-   **Student Monitoring**: Collects tab titles, URLs, timestamps, and favicons every 10 seconds, with real-time alerts for domain blocklist violations. Classifies students as Online, Idle, or Offline based on heartbeat. Displays lock status icon on student tiles.
-   **Camera Usage Monitoring**: Detects when students activate their cameras via the Chrome extension content script. Teachers receive real-time notifications and can see which students have active cameras through visual indicators (purple camera icon) on student tiles and a dedicated "Camera Active" stat card. Camera detection uses a non-intrusive approach by wrapping the MediaDevices getUserMedia API.
-   **Website Duration Tracking**: Calculates and displays time spent on websites by grouping consecutive heartbeats into sessions.
-   **Admin System**: Manages teacher accounts (create, view, delete).
-   **Data Retention**: Configurable data retention with automatic cleanup and Excel export.
-   **Remote Classroom Control**: Includes features like:
    -   **Remote Tab Control**: Open tabs, close tabs, lock/unlock screens. When screen is locked, students are restricted to a single tab and cannot create new tabs.
    -   **Apply Scenes**: Apply predefined scenes with multiple allowed domains to restrict student browsing to specific educational websites.
    -   **Student Groups**: Organize students for targeted instruction.
    -   **Tab Limiting**: Configure maximum tabs per student.
    -   **Per-Student Targeting**: All remote commands support targeting specific students via checkbox selection.

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
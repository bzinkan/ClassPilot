# Classroom Screen Awareness - Teacher Dashboard & Chrome Extension

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
- **Real-time Communication**: A WebSocket server facilitates live updates for teacher dashboards and WebRTC communication for screen sharing.
- **Security**: Implements role-based access control (admin/teacher), bcrypt for password hashing, Express session management, rate limiting, and CSRF protection. An admin middleware protects sensitive routes.
- **Chrome Extension**: A Manifest V3 extension manages automatic tab and URL monitoring, displays privacy disclosure, and facilitates opt-in screen sharing via WebRTC.

### Feature Specifications
- **Teacher Dashboard**: Displays live student activity (tab title, URL, status), manages class rosters, and configures data retention.
  - **Customizable Grade Tabs**: Teachers can configure which grade levels appear as filter tabs on the dashboard (e.g., "6, 7, 8" or "9, 10, 11, 12"). Grade tabs are set in Settings and dynamically update the dashboard filtering.
  - **Delete Devices**: Teachers can delete student devices directly from the dashboard with a confirmation dialog. Deletion removes the device from both the dashboard and roster.
  - **Roster Navigation**: Dedicated "Roster" button in dashboard header provides quick access to roster management page.
  - **Two-Stage Device Registration**: Devices register first with Device ID, Classroom Location, and Device Number via Chrome Extension, then teachers can assign student names and grade levels later from the dashboard or Roster page.
- **Roster Management Page**: A dedicated page (`/roster`) for comprehensive device roster management, separate from Settings page:
  - **View All Devices**: Displays all registered devices grouped by classroom location (classId)
  - **Edit Device Information**: Attach student names and grade levels to devices, update device names and classroom assignments
  - **Delete Devices**: Remove devices with confirmation dialogs from roster table
  - **Table View**: Displays all devices with their assigned information organized by classroom
  - **Grade Level Tracking**: Nullable field to accommodate various school structures and unassigned devices
  - **Device Name Support**: Easier Chromebook identification (e.g., "Chromebook 1", "Lab Computer 5")
  - **Persistent Storage**: Database-backed storage ensures roster data survives server restarts
  - **Automatic Refresh**: Query cache invalidation ensures roster table updates immediately after edits
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
- **Deployment**: Designed for production readiness, including specific considerations for Google Admin force-install of the Chrome Extension.
- **IP Allowlist**: Basic IP-based access control is available for securing teacher dashboard access.

## External Dependencies
- **Database**: PostgreSQL (Neon-backed)
- **ORM**: Drizzle ORM
- **Frontend Libraries**: React, TypeScript, TanStack Query, Tailwind CSS, Shadcn UI components
- **Backend Libraries**: Express, Node.js, `ws` (WebSocket library), bcrypt
- **APIs**: WebRTC for screen sharing
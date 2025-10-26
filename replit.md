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
The frontend is built with React and TypeScript, using Tailwind CSS for styling with custom design tokens tailored for an educational UI. It supports dark/light mode and features a grid-based dashboard with student tiles for real-time activity display. Detailed student information is accessible via a drawer, and admin functionalities are available through a dedicated interface.

### Technical Implementations
The system uses a full-stack architecture:
- **Frontend**: React, TypeScript, TanStack Query for server state, WebSocket for real-time updates.
- **Backend**: Express and Node.js, providing RESTful APIs for authentication, student device registration, heartbeat updates, event logging, student data retrieval, WebRTC signaling, and school settings management.
- **Real-time Communication**: A WebSocket server facilitates live updates for teacher dashboards and WebRTC communication for screen sharing.
- **Security**: Implements role-based access control (admin/teacher), bcrypt for password hashing, Express session management, rate limiting, and CSRF protection. An admin middleware protects sensitive routes.
- **Chrome Extension**: A Manifest V3 extension manages automatic tab and URL monitoring, displays privacy disclosure, and facilitates opt-in screen sharing via WebRTC.

### Feature Specifications
- **Teacher Dashboard**: Displays live student activity (tab title, URL, status), manages class rosters, and configures data retention.
- **Roster Management**: Comprehensive student roster management with:
  - Manual student creation (individual or bulk) with name, device ID, class ID, and grade level
  - Edit student information including grade level assignment
  - Delete students with confirmation dialogs
  - CSV upload support for bulk roster imports (format: studentName, deviceId, classId, gradeLevel)
  - Table view displaying all students with their assigned information
  - Grade level tracking (nullable field to accommodate various school structures)
  - Persistent database storage ensuring roster data survives server restarts
- **Student Monitoring**: Automatically collects tab titles, URLs, timestamps, and favicons every 10 seconds. Provides real-time alerts for domain blocklist violations.
- **Opt-In Screen Sharing**: Students explicitly consent to screen sharing, with clear visual indicators when active.
- **Admin System**: Allows IT administrators to manage teacher accounts (create, view, delete).
- **Data Retention**: Configurable data retention (default 24 hours) with automatic cleanup and Excel export capabilities.
- **Student Status Logic**: Classifies students as Online, Idle, or Offline based on heartbeat timestamps.

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
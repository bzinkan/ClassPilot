# Classroom Screen Awareness - Teacher Dashboard & Chrome Extension

A privacy-aware classroom monitoring system that helps teachers see what students are doing on their managed Chromebooks with transparent disclosure and opt-in screen sharing.

## Project Overview

This is a full-stack web application with a teacher dashboard and Chrome Extension MV3 for monitoring student activity on managed Chromebooks in educational settings.

### Key Features
- **Teacher Dashboard**: Live grid of student tiles showing real-time activity (active tab title, URL, last-seen status)
- **WebSocket Real-time Updates**: Instant notifications when students change tabs or update their activity
- **Privacy-First Design**: All monitoring is visible to students with clear disclosure banners
- **Opt-In Screen Sharing**: Students must explicitly click to share their screen with visible indicators
- **Class Roster Management**: Upload CSV files to organize students by class
- **Data Retention Controls**: Configurable 24-hour default retention with automatic cleanup
- **FERPA/COPPA Compliance**: Minimal data collection (tab titles, URLs, timestamps only - no keystrokes, mic, or camera)

## Architecture

### Frontend (React + TypeScript)
- **Pages**:
  - `/` - Login page for teachers
  - `/dashboard` - Main dashboard with student tiles and real-time updates
  - `/settings` - Settings page for school info, rosters, and configuration
- **Components**:
  - `StudentTile` - Card showing student status with Online/Idle/Offline indicators
  - `StudentDetailDrawer` - Detailed view with URL history and WebRTC viewer
  - `ThemeProvider` - Dark/light mode support
- **State Management**: TanStack Query for server state, WebSocket for real-time updates
- **Styling**: Tailwind CSS with custom design tokens for educational UI

### Backend (Express + Node.js)
- **API Endpoints**:
  - `POST /api/login` - Teacher authentication
  - `POST /api/register` - Student device registration (from extension)
  - `POST /api/heartbeat` - Student activity updates (every 10 seconds)
  - `POST /api/event` - Event logging (consent changes, tab changes)
  - `GET /api/students` - Get all students with current status
  - `GET /api/heartbeats/:deviceId` - Get URL history for a student
  - `POST /api/signal/:deviceId` - WebRTC signaling for screen sharing
  - `GET/POST /api/settings` - School settings management
  - `POST /api/roster/upload` - CSV roster upload
  - `GET /api/export/csv` - Export activity data
- **WebSocket Server**: Real-time communication on `/ws` path
  - Teacher channel: Receives updates when students change activity
  - Student channel: For WebRTC signaling and extension communication
- **Security**: 
  - bcrypt password hashing
  - Express session management
  - Rate limiting (100 req/min general, 2 req/10s for heartbeats)
  - CSRF protection via session cookies
- **Data Storage**: In-memory storage (MemStorage) for MVP - can be swapped for PostgreSQL

### Chrome Extension (Manifest V3) - Not Yet Built
Will include:
- Service worker for background heartbeats
- Content script for tab monitoring
- Popup UI with monitoring disclosure and share button
- WebRTC implementation for screen sharing

## Default Credentials

**Teacher Account**:
- Username: `teacher`
- Password: `teacher123`

⚠️ **IMPORTANT**: Change this password immediately in production!

## Environment Variables

Required in production:
- `SESSION_SECRET` - Session encryption key (already set in Replit)
- `WS_SHARED_KEY` - WebSocket authentication key (optional, defaults to "change-this-websocket-key")
- `SCHOOL_ID` - School identifier (optional, defaults to "default-school")

## Student Status Logic

Students are classified into three states based on their last heartbeat:
- **Online**: Last seen < 30 seconds ago (green dot, solid border, pulsing indicator)
- **Idle**: Last seen 30-120 seconds ago (yellow dot, dashed border)
- **Offline**: Last seen > 120 seconds ago (gray dot, thin border, reduced opacity)

## Data Retention

- Heartbeat data is automatically cleaned up based on retention hours setting (default: 24 hours)
- Cleanup runs every hour automatically
- Teachers can export CSV data before it's deleted

## WebSocket Protocol

### Authentication
```json
{ "type": "auth", "role": "teacher" }
{ "type": "auth", "role": "student", "deviceId": "device-123" }
```

### Teacher Updates
```json
{
  "type": "student-update",
  "deviceId": "device-123"
}
```

### WebRTC Signaling
```json
{
  "type": "signal",
  "data": {
    "type": "offer|answer|ice-candidate",
    "data": "<SDP or ICE candidate>",
    "deviceId": "device-123"
  }
}
```

## CSV Roster Format

Upload CSV files with the following columns:
```
studentName,deviceId,classId
John Doe,device-001,class-101
Jane Smith,device-002,class-101
```

## Recent Changes
- 2025-01-24: Initial implementation with complete teacher dashboard, backend API, WebSocket server, and authentication
- Teacher dashboard features live student tiles, real-time updates, search, and status indicators
- Settings page with roster upload, blocked domains, and data retention controls
- Dark/light theme support with theme toggle
- Session-based authentication with bcrypt password hashing
- Rate limiting on all API endpoints

## Next Steps
1. Build Chrome Extension MV3 (Task 4)
2. Implement WebRTC screen sharing functionality
3. Test end-to-end with extension installed on Chromebook
4. Add production PostgreSQL database support
5. Deploy and create deployment documentation

## Development

The project uses:
- Vite for frontend development with HMR
- Express for backend API
- WebSocket (ws library) for real-time updates
- In-memory storage for MVP (easy to swap for PostgreSQL)
- TanStack Query for data fetching
- Shadcn UI components with Tailwind CSS

## Privacy & Compliance

This system is designed to be FERPA and COPPA compliant:
- All monitoring is visible to students
- Clear disclosure in extension popup
- Screen sharing requires explicit consent
- Minimal data collection (no keystrokes, no mic/camera)
- Configurable data retention with automatic cleanup
- Audit logging for consent events

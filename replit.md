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
  - `/` - Login page for teachers and admins
  - `/dashboard` - Main dashboard with student tiles and real-time updates
  - `/admin` - Admin dashboard for managing teacher accounts (admin-only)
  - `/settings` - Settings page for school info, rosters, and configuration
- **Components**:
  - `StudentTile` - Card showing student status with Online/Idle/Offline indicators
  - `StudentDetailDrawer` - Detailed view with URL history and WebRTC viewer
  - `ThemeProvider` - Dark/light mode support
- **State Management**: TanStack Query for server state, WebSocket for real-time updates
- **Styling**: Tailwind CSS with custom design tokens for educational UI

### Backend (Express + Node.js)
- **API Endpoints**:
  - `POST /api/login` - Teacher/admin authentication
  - `GET /api/me` - Get current user info (requires auth)
  - `POST /api/register` - Student device registration (from extension)
  - `POST /api/heartbeat` - Student activity updates (every 10 seconds)
  - `POST /api/event` - Event logging (consent changes, tab changes)
  - `GET /api/students` - Get all students with current status (protected by IP allowlist)
  - `GET /api/heartbeats/:deviceId` - Get URL history for a student (protected by IP allowlist)
  - `POST /api/signal/:deviceId` - WebRTC signaling for screen sharing
  - `POST /api/ping/:deviceId` - Send notification message to student (protected by IP allowlist)
  - `GET/POST /api/settings` - School settings management (protected by IP allowlist)
  - `POST /api/roster/upload` - CSV roster upload (protected by IP allowlist)
  - `GET /api/export/activity` - Export activity data with date range filter (protected by IP allowlist)
  - `GET /api/export/csv` - Legacy CSV export (protected by IP allowlist)
  - **Admin Routes** (admin-only):
    - `GET /api/admin/teachers` - List all teacher accounts (excludes admins)
    - `POST /api/admin/teachers` - Create new teacher account
    - `DELETE /api/admin/teachers/:id` - Delete teacher account (blocks admin deletion)
- **WebSocket Server**: Real-time communication on `/ws` path
  - Teacher channel: Receives updates when students change activity
  - Student channel: For WebRTC signaling and extension communication
- **Security**: 
  - Role-based access control (admin and teacher roles)
  - bcrypt password hashing
  - Express session management
  - Rate limiting (100 req/min general, 2 req/10s for heartbeats)
  - CSRF protection via session cookies
  - Admin middleware to protect sensitive routes
- **Data Storage**: In-memory storage (MemStorage) for MVP - can be swapped for PostgreSQL

### Chrome Extension (Manifest V3) ✅ COMPLETE
Located in `/extension` directory:
- **manifest.json**: Manifest V3 with all required permissions (tabs, storage, identity)
- **service-worker.js**: Background service worker for 10-second heartbeats and tab monitoring
- **popup.html/popup.js**: Extension popup with privacy disclosure banner and opt-in screen share button
- **content-script.js**: Monitors active tab changes
- **icons/**: PNG icons (16px, 48px, 128px) for Chrome Admin packaging
- **WebRTC Implementation**: Full screen sharing with explicit student consent and WebSocket signaling

**Extension Features**:
- **Automatic tab & URL monitoring** - Fully automatic from student login, no action required
- Privacy disclosure banner showing "Monitoring Active"
- Optional screen sharing with explicit student consent (click to start)
- Visual indicator when screen sharing is active (pulsing red dot)
- WebRTC signaling through authenticated WebSocket connection
- Heartbeat every 10 seconds with current tab title, URL, favicon
- Ready for Google Admin force-install on managed Chromebooks

**Monitoring Capabilities**:
- ✅ **Fully Automatic**: Tab titles, URLs, timestamps, favicons - collected every 10 seconds
- ✅ **Real-time Alerts**: Domain blocklist violations with instant notifications
- ✅ **URL History**: Last 20 URLs visited per student
- ✅ **Status Tracking**: Online/Idle/Offline indicators based on heartbeat
- ⚠️ **Optional**: Screen sharing requires student to click "Share My Screen" button

## Default Credentials

**Admin Account** (can manage teacher accounts):
- Username: `admin`
- Password: `admin123`

**Teacher Account** (can view student monitoring):
- Username: `teacher`
- Password: `teacher123`

⚠️ **IMPORTANT**: Change these passwords immediately in production!

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

### October 25, 2025 - Admin System & Enhanced Features
**Admin System Implemented (Option 1):**
- ✅ **Role-Based Access Control**: Two user roles - 'admin' and 'teacher'
- ✅ **Admin Dashboard** (`/admin`): Dedicated page for IT administrators to manage teacher accounts
- ✅ **Teacher Account Management**: 
  - Create new teacher accounts with username, password, and school name
  - View list of all teachers (excludes admin accounts from the list)
  - Delete teacher accounts (with protection against deleting admins or self-deletion)
- ✅ **Conditional UI**: Admin button (Shield icon) only appears in dashboard header for admin users
- ✅ **Security Guards**:
  - `requireAdmin` middleware protects admin routes
  - API filters ensure only teachers are listed/managed
  - 403 error when attempting to delete admin accounts
  - Username uniqueness validation
- ✅ **Default Admin Account**: `admin/admin123` for initial setup

**Other Enhanced Features:**
- ✅ Domain blocklist with violation alerts - Red border on student tiles when visiting blocked domains, real-time alert notifications
- ✅ CSV activity export with date range filtering - Export student activity data with custom date ranges (defaults to 7 days)
- ✅ Ping student notifications - Send custom messages to students via Chrome extension notifications
- ✅ IP allowlist security (MVP with limitations) - Restrict teacher dashboard access by IP address

**IP Allowlist Implementation Notes:**
The IP allowlist feature provides basic IP-based access control with the following characteristics:
- ✅ Works correctly for direct server connections (development, small deployments)
- ⚠️ **Reverse proxy deployments require additional configuration**:
  - Production deployments behind nginx, Apache, or cloud load balancers need Express `trust proxy` configuration
  - Without proxy configuration, the server sees the proxy's IP instead of client IPs
  - Operators must configure allowlist with proxy IPs or disable the feature in proxy environments
- Production-only enforcement (disabled in development to avoid breaking local workflow)
- Exact IP matching only (no CIDR support in current implementation)
- Fail-open error handling to prevent total lockout
- Documented in code comments for deployment teams

**Previous Core Features:**
- ✅ Full-stack teacher dashboard with live student monitoring
- ✅ Backend API with authentication, WebSocket server, and rate limiting
- ✅ Chrome Extension MV3 with service worker, popup UI, and tab monitoring
- ✅ End-to-end WebRTC screen sharing with opt-in consent flows
- ✅ Settings page with CSV roster upload and data retention controls
- ✅ Student detail drawer with URL history (last 20 URLs) and live screen viewer
- ✅ Dark/light theme support throughout application
- ✅ Privacy-first design with FERPA/COPPA compliance features
- ✅ Extension icons and deployment package ready for Google Admin

## Deployment Ready ✅

The system is production-ready! See `DEPLOYMENT.md` for complete deployment instructions.

## Admin System Features

The system now includes a complete admin management interface for IT administrators:

### Admin Capabilities
- **Create Teacher Accounts**: Add new teachers with unique usernames and passwords
- **View Teacher List**: See all teacher accounts in the system (admins are hidden from this list)
- **Delete Teachers**: Remove teacher accounts when needed (protected against deleting admins)
- **Secure Access**: Only users with 'admin' role can access admin features

### Navigation
- Admins see a Shield icon button in the dashboard header to access `/admin`
- Teachers see only the normal dashboard features
- Back button in admin page to return to dashboard

### Security Features
- Username uniqueness validation (no duplicate usernames)
- Password hashing with bcrypt
- Role-based middleware (`requireAdmin`) protects all admin routes
- Cannot delete admin accounts (returns 403 error)
- Cannot delete your own account (prevents lockout)

### Optional Enhancements (Post-MVP)
1. Migrate from in-memory storage to PostgreSQL for data persistence across restarts
2. Add password reset functionality for teachers
3. Implement screenshot capture alongside screen sharing
4. Add activity reports and analytics dashboard
5. Build student-facing web portal for transparency
6. Add browser extension for Firefox/Edge support
7. Add audit logging for admin actions (create/delete teacher accounts)

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

# ClassPilot - IT Staff Tutorial & Technical Breakdown

**Presentation Date**: [Your Date]  
**Version**: 2.7.1
**Presented by**: [Your Name]

> **Production boundary:** SchoolPilot is the only production API and teacher
> web application. Deploy it from the SchoolPilot repository using its
> `CLAUDE.md` and `docs/CLASSPILOT_2_7_1_RELEASE.md` runbooks. Replit and the
> standalone server in this repository are historical prototype material, not a
> production path. This repository's production deliverable is only the
> verified `dist/ClassPilot-v2.7.1.zip` Chrome Web Store artifact built from a
> clean tagged commit; never package the extension manually.

---

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [System Architecture](#system-architecture)
3. [Key Features](#key-features)
4. [Privacy & Compliance](#privacy--compliance)
5. [Deployment Guide](#deployment-guide)
6. [Demo Walkthrough](#demo-walkthrough)
7. [Troubleshooting](#troubleshooting)

---

## Executive Summary

**What is ClassPilot?**

ClassPilot is a privacy-aware classroom monitoring system designed for educational institutions using managed Chromebooks. It enables teachers to monitor student activity in real time while providing controls that support schools' FERPA/COPPA responsibilities; each school remains responsible for its own policies, notices, and required consent decisions.

**Core Components:**
- **Teacher Dashboard** (Web Application) - Real-time monitoring interface for educators
- **Chrome Extension** (v2.7.1) - Lightweight monitoring agent on student Chromebooks

**Key Value Propositions:**
- ✅ Transparent monitoring with student disclosure
- ✅ Real-time classroom oversight
- ✅ Remote classroom control capabilities
- ✅ Privacy-first design with configurable data retention
- ✅ Works with Google Workspace for Education

---

## System Architecture

### High-Level Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     ClassPilot System                        │
└─────────────────────────────────────────────────────────────┘

┌──────────────────┐         ┌──────────────────┐
│  Student Device  │         │  Teacher Device  │
│  (Chromebook)    │         │  (Any Browser)   │
│                  │         │                  │
│  ┌────────────┐  │         │  ┌────────────┐  │
│  │  Chrome    │  │         │  │  Dashboard │  │
│  │ Extension  │◄─┼─────────┼─►│  Web App   │  │
│  │  (v2.7.1)  │  │         │  │            │  │
│  └────────────┘  │         │  └────────────┘  │
└────────┬─────────┘         └────────┬─────────┘
         │                            │
         │        WebSocket/REST      │
         └────────────┬───────────────┘
                      │
            ┌─────────▼─────────┐
            │   Backend Server   │
            │   (Node.js/Express)│
            │                    │
            │   • REST APIs      │
            │   • WebSocket      │
            │   • WebRTC Signal  │
            └─────────┬──────────┘
                      │
            ┌─────────▼─────────┐
            │   PostgreSQL DB    │
            │   (AWS RDS)        │
            │                    │
            │   • Students       │
            │   • Devices        │
            │   • Activity Logs  │
            │   • Sessions       │
            └────────────────────┘
```

### Technology Stack

**Frontend (Teacher Dashboard):**
- React + TypeScript
- TanStack Query (data fetching)
- Tailwind CSS + Shadcn UI (styling)
- Wouter (routing)
- WebSockets (real-time updates)
- WebRTC (live screen viewing)

**Backend:**
- Node.js + Express
- WebSocket server (ws library)
- PostgreSQL database (AWS RDS, reached by the SchoolPilot services)
- Drizzle ORM
- Session-based authentication
- Rate limiting & CSRF protection

**Chrome Extension:**
- Manifest V3 (latest Chrome standard)
- Chrome Identity API (student detection)
- Background service worker with chrome.alarms
- WebNavigation API (browsing tracking)
- WebRTC (screen sharing)

---

## Key Features

### 1. Real-Time Student Monitoring

**How it Works:**
- Chrome Extension sends heartbeats every 10 seconds
- Reports current tab title, URL, favicon, and timestamp
- Tracks all open tabs (up to 20 per device)
- Dashboard updates in real-time via WebSocket

**Student Status Classifications:**
- 🟢 **Online** - Active within last 30 seconds
- 🟡 **Idle** - No activity for 30-120 seconds
- ⚫ **Offline** - No activity for 2+ minutes

**What Teachers See:**
- Student name and device
- Current active tab and website
- All open tabs across all devices
- Time spent on current site
- Recent browsing history

### 2. Session-Based Classroom Management

**Class Sessions:**
- Teachers create class rosters/groups
- Start a class session when teaching begins
- Dashboard filters to show only students in active session
- End session when class concludes

**Benefits:**
- Organized view of current class
- Historical session tracking
- Prevents clutter from inactive students

### 3. Remote Classroom Control

**Available Commands:**

**Open Tab** 📂
- Send URL to selected students
- Opens in new tab on their Chromebook
- Useful for directing to assignments

**Close Tabs** ❌
- Close all tabs or specific tabs by pattern
- Per-device targeting (no cross-device pollution)
- Composite key system: `studentId|deviceId|url`

**Lock Screen** 🔒
- Prevents student from browsing
- Shows "Screen Locked by Teacher" message
- Maintains focus until unlocked

**Unlock Screen** 🔓
- Restores normal browsing capability

**Apply Flight Path** 🛤️
- Pre-configured allowed/blocked domain lists
- Restrict browsing to approved sites
- Useful for test-taking or focused work

**Student Groups** 👥
- Target multiple students at once
- Bulk apply controls efficiently

**Tab Limiting** 📊
- Set maximum number of open tabs
- Prevents tab chaos and distraction

### 4. Live Screen Viewing

**WebRTC Screen Sharing:**
- Real-time screen capture from student devices
- Silent tab capture (works on managed Chromebooks)
- Advanced video controls (play/pause/fullscreen)
- Privacy disclosure banner shown to students

**Technical Details:**
- Uses WebRTC peer-to-peer connection
- Offscreen document (MV3 compliant)
- Automatic reconnection on network issues

### 5. Website Duration Tracking

**Analytics:**
- Calculates time spent on each website
- Interactive pie chart visualization
- Student-specific analytics in detail drawer
- Helps identify engagement patterns

### 6. Flight Path System

**Domain Management:**
- **Allowed Domains** - Whitelist of permitted sites
- **Blocked Domains** - Blacklist of restricted sites
- Real-time violation alerts for teachers

**Example Use Cases:**
- Test-taking: Only allow testing platform
- Research: Block social media, allow educational sites
- Focus time: Restrict to specific curriculum sites

### 7. Privacy & Data Retention

**Configurable Data Retention:**
- Set activity-history retention to a whole number from 1 through 365 days (default 30)
- Automatic cleanup of old activity logs
- CSV export before deletion

**Privacy Features:**
- Tab state is bounded and identity-bound; the extension may persist a limited local snapshot so exact tab references survive worker restarts
- Student-facing indicators show when school-managed monitoring is active
- Ambient screenshot thumbnails require a short-lived authorized observation lease; exact safety captures require a separate exact-bound request
- Live View is an authorized, temporary encrypted stream and is not recorded by the extension or SchoolPilot servers; the teacher dashboard can explicitly save a local recording or still image, which the school must govern
- The school setting governs heartbeat history and related session-report detail; ambient thumbnails, safety evidence, communications, account/audit records, and teacher-downloaded files follow their separate documented or contractual policies

### 8. Multi-Tenancy Support

**Teacher Isolation:**
- Each teacher has isolated resources
- Private Flight Paths and Student Groups
- Student assignments per teacher
- Admin can manage all teachers

**Admin Capabilities:**
- Create/manage teacher accounts
- Create official class rosters
- Assign students to classes
- Bulk student import via CSV
- System-wide settings management

### 9. School Tracking Hours

**Time-Based Monitoring:**
- Configure school hours (e.g., 8 AM - 3 PM)
- Optional weekend monitoring
- Reduces data collection to school hours only
- Privacy-focused feature

### 10. Shared Chromebook Support

**Device-First Architecture:**
- Multiple students can use same Chromebook
- Automatic student detection via Chrome Identity API
- Session-based device tracking
- Student-specific activity history per device

**How It Works:**
- Student A logs in → Extension detects email → Maps to Student A
- Student B logs in → Extension detects new email → Switches to Student B
- Each student's activity tracked separately

---

## Privacy & Compliance

### FERPA/COPPA Compliance

**Data Minimization:**
- Processes school-issued student/session identifiers, a device identifier, active-tab URL/title/timestamps, heartbeat state, and classroom communications needed for the service
- May process observation-bound thumbnail screenshots and one exact-bound safety screenshot; Live View media is temporary and is not recorded by the extension or SchoolPilot servers, although an authorized teacher can explicitly save a local copy from the dashboard
- An authorized managed-kiosk launch may send the Chrome directory device ID to SchoolPilot after capability preflight; it is immediately converted to a school-scoped opaque ID and is not stored or logged raw
- Does not intentionally collect keystrokes, typed passwords, microphone audio, camera video, incognito-window activity, or browsing from unmanaged profiles

**Transparency:**
- Chrome Extension displays disclosure banner
- Students know monitoring is active
- Live View requires an authorized teacher request; managed Chrome policy determines whether Chrome shows a screen picker

**Data Security:**
- Session-based authentication with bcrypt password hashing
- Rate limiting to prevent brute force attacks
- CSRF protection
- Secure WebSocket connections
- IP allowlist for dashboard access (optional)

**Student Rights:**
- Configurable data retention
- Export capability for records
- Clear monitoring boundaries

### Google Workspace Compatibility

**Supported Environments:**
- ✅ Google Workspace for Education accounts (@school.edu)
- ✅ Personal Google accounts (@gmail.com)
- ✅ Mixed environments (both types)

**Chrome Identity API:**
- Automatically detects logged-in student email
- No manual student ID entry required
- Works across devices seamlessly

---

## Deployment Guide

### Prerequisites

1. **Google Workspace Admin Access** (for pinning and force-installing the extension)
2. **Access to the SchoolPilot production repository and AWS deployment role**
3. **A clean, reviewed, tagged ClassPilot 2.7.1 commit with green CI**
4. **The managed test OU and production OU rollout record**

### Step 1: Deploy SchoolPilot compatibility code

Use only the guarded production procedure in the SchoolPilot repository's
`CLAUDE.md` and `docs/CLASSPILOT_2_7_1_RELEASE.md`. Deploy the reviewed backend
first and frontend second, smoke the live 2.7.0 compatibility path, and retain
the prior ECS task definitions and deployment evidence. Do not deploy the
prototype server in this repository, publish from Replit, run a local database
push against production, or create a bootstrap administrator through a public
registration endpoint.

### Step 2: Publish Chrome Extension to Chrome Web Store

**Package the Extension:**

```bash
npm run check
npm test
npm run test:extension:chrome
npm run build
./extension/package-extension.sh
npm run test:extension:package
node scripts/verify-extension-package.mjs dist/ClassPilot-v2.7.1.zip --verify-only
```

Run these commands from the clean tagged ClassPilot repository root. Verify and
retain `dist/ClassPilot-v2.7.1.zip.sha256`; upload that exact versioned archive,
not a manually assembled or unversioned ZIP.

**Upload to Chrome Web Store:**

1. Go to: https://chrome.google.com/webstore/devconsole
2. Pay $5 one-time developer fee (if first extension)
3. Upload `dist/ClassPilot-v2.7.1.zip` from the clean, tagged release commit
4. Fill in store listing details:
   - **Name:** ClassPilot
   - **Description:** Privacy-aware classroom monitoring for managed Chromebooks
   - **Screenshots:** (capture from demo)
   - **Icon:** Already included (128x128px)
5. Select visibility: **Private** (unlisted) or **Public**
6. Submit for Chrome Web Store review

**Important:** For school deployment, you can use **unlisted** mode. Schools will install via Extension ID, not public store.

### Step 3: Configure Google Workspace Admin Console

**Force-Install Extension on Student Chromebooks:**

1. Go to: https://admin.google.com
2. Navigate to: **Devices** → **Chrome** → **Apps & Extensions** → **Users & Browsers**
3. Click "Add Chrome app or extension"
4. Enter Extension ID: `[Your Extension ID from Chrome Web Store]`
5. Configure installation policy:
   - **Installation Policy:** Force install
   - **Organizational Unit:** Select student OU (e.g., "Students")
6. Save

**Extension Configuration (Optional):**

You can set the dashboard URL via policy:

```json
{
  "dashboardUrl": "https://your-dashboard-url.com"
}
```

### Step 4: Configure Dashboard

**Initial Setup:**

1. Login as admin
2. Navigate to Settings
3. Configure:
   - **School Name**
   - **Grade Levels** (e.g., 6th, 7th, 8th)
   - **Tracking Hours** (e.g., 8:00 AM - 3:00 PM)
   - **Weekend Tracking** (on/off)
   - **Activity-History Retention** (1–365 whole days; default 30)
   - **IP Allowlist** (optional - restrict dashboard access)

**Create Teachers:**

Admin → Teachers → Add Teacher
- Enter username, password, assign to school

**Import Students (CSV):**

Admin → Students → Import CSV

CSV format:
```csv
name,email,grade
John Smith,john.smith@school.edu,8th
Jane Doe,jane.doe@school.edu,7th
```

### Step 5: Teacher Onboarding

**Teacher Account Setup:**

1. Provide login credentials
2. Teachers access dashboard at: `https://your-dashboard-url.com`
3. Teachers create class rosters:
   - Dashboard → Roster Management
   - Create Group → Add students
4. Start class session when teaching begins

---

## Demo Walkthrough

### Recommended Demo Flow (15 minutes)

**1. Login & Overview (2 min)**
- Show login page
- Explain teacher vs admin roles
- Point out ClassPilot branding

**2. Dashboard Overview (3 min)**
- Show empty dashboard (no active students yet)
- Explain status cards: Online, Idle, Offline, Off-Task Alert
- Show grade filter dropdown
- Point out student search

**3. Start Class Session (1 min)**
- Click "Select Class" dropdown
- Choose a class roster
- Click "Start Class"
- Explain: Dashboard now shows students from this roster

**4. Student Activity Monitoring (4 min)**

*At this point, have a test Chromebook with extension installed, or simulate*

- Student appears as "Online" when extension sends heartbeat
- Show student tile with:
  - Name, device name
  - Current tab title and favicon
  - Status indicator (green dot)
- Click student tile to open detail drawer
- Show "Screens" tab with all open tabs
- Show "History" tab with recent browsing activity
- Show analytics pie chart (time on site)

**5. Remote Control Demo (3 min)**

*Select a student and demonstrate:*

- **Open Tab:** Enter a URL → Opens on student device
- **Close Tabs:** Select specific tab → Closes on student device
- **Lock Screen:** Locks student Chromebook (show banner on student side)
- **Unlock Screen:** Restores browsing
- **Apply Flight Path:** Show domain restrictions in action

**6. Flight Paths (1 min)**
- Navigate to Flight Paths page
- Create example: "Testing Mode"
- Allowed: `testing-platform.com`
- Blocked: `youtube.com, facebook.com, instagram.com`
- Show how to apply to students

**7. Admin Features (1 min)**
- Switch to admin account
- Show teacher management
- Show student import (CSV)
- Show system settings

**8. Q&A and Closing**
- Answer technical questions
- Discuss deployment timeline

---

## Troubleshooting

### Common Issues

**Issue: Extension not appearing on student Chromebooks**

**Solution:**
- Verify extension is force-installed in Admin Console
- Check correct OU is targeted (Students, not Staff)
- Verify Chrome policies are applied (run `chrome://policy`)
- Wait 15 minutes for policy refresh, or force refresh

**Issue: Student not appearing in dashboard**

**Possible Causes:**
1. Student not in active session roster
2. Student email not matching database
3. Extension not sending heartbeats

**Solution:**
- Ensure student is added to class roster
- Verify student email in Admin → Students
- Check extension popup on student device
- Check browser console for errors

**Issue: WebSocket connection failing**

**Solution:**
- Verify WebSocket port is open (default: same as web port)
- Check firewall settings
- Ensure HTTPS for production (WSS requires HTTPS)

**Issue: Screen sharing not working**

**Possible Causes:**
- The teacher or teaching-session authority changed
- The extension does not have current ICE/TURN credentials
- WebRTC is blocked by the network

**Solution:**
- Verify Chromebook is managed via Admin Console
- Check extension permissions in `chrome://extensions`
- Start a fresh Live View request for the exact current student/session
- Test direct ICE and TURN/TURNS fallback; unmanaged devices must also complete
  Chrome's capture picker

---

## Technical Specifications

### System Requirements

**Teacher Dashboard:**
- Modern web browser (Chrome, Firefox, Edge, Safari)
- Internet connection
- Screen resolution: 1280x720 minimum

**Student Devices:**
- Chrome OS (managed Chromebook)
- Chrome browser 100+ (Manifest V3 support)
- Internet connection
- ClassPilot extension installed

**Server:**
- Node.js 24+
- PostgreSQL 14+
- 512MB RAM minimum (1GB recommended)
- 10GB storage

### Network Requirements

**Ports:**
- HTTPS: 443 (dashboard)
- WebSocket: Same as HTTPS port
- WebRTC: Uses STUN/TURN (standard WebRTC ports)

**Bandwidth:**
- Per student: ~1KB every 10 seconds (heartbeat)
- Dashboard: ~10KB/s for 30 students
- Screen sharing: 500KB/s - 2MB/s per stream

---

## Security Considerations

### Access Control

**Dashboard Access:**
- Session-based authentication
- Bcrypt password hashing
- Optional IP allowlist
- Rate limiting on login attempts

**Extension Security:**
- Communicates only with configured dashboard URL
- WebSocket authentication with session token
- No external API calls
- Manifest V3 security standards

### Data Protection

**In Transit:**
- HTTPS for all web traffic
- WSS (WebSocket Secure) for real-time updates
- WebRTC encryption for screen sharing

**At Rest:**
- PostgreSQL database encryption
- Password hashing (bcrypt)
- Session secrets in environment variables

---

## Support & Maintenance

### Regular Maintenance Tasks

**Weekly:**
- Monitor database size
- Check error logs
- Verify extension is updating

**Monthly:**
- Review data retention settings
- Export old activity logs (if needed)
- Update teacher accounts as needed

**Quarterly:**
- Update Chrome Extension (if new features)
- Review and update Flight Paths
- Conduct security audit

### Getting Help

**Extension Issues:**
- Check Chrome Extension developer dashboard
- Review extension logs in student browser console
- Verify Google Workspace policies

**Dashboard Issues:**
- Check server logs
- Verify database connection
- Test WebSocket connectivity

**Database Issues:**
- Monitor PostgreSQL logs
- Check connection pool
- Verify disk space

---

## Conclusion

ClassPilot provides a comprehensive, privacy-aware classroom monitoring solution that balances educational oversight with student privacy rights. The system is designed for easy deployment in Google Workspace for Education environments and scales from small classrooms to entire school districts.

**Key Takeaways:**
- ✅ Two components: Chrome Extension + Web Dashboard
- ✅ Privacy-first design with transparency
- ✅ Real-time monitoring with remote control
- ✅ Easy deployment via Google Workspace Admin
- ✅ Architecture designed to support school FERPA/COPPA responsibilities

**Next Steps:**
1. Schedule deployment timeline
2. Prepare Google Workspace Admin Console
3. Create teacher accounts
4. Import student roster
5. Pilot with 1-2 classrooms
6. Gather feedback and refine
7. Roll out school-wide

---

**Questions?**

Contact: [Your Contact Information]

---

*ClassPilot v2.7.1 - Privacy-Aware Classroom Monitoring*

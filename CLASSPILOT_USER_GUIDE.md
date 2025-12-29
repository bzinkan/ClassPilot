# ClassPilot User Guide

**Version 1.0** | Privacy-Aware Classroom Screen Monitoring System

---

## Table of Contents

1. [Overview](#overview)
2. [Getting Started](#getting-started)
3. [Dashboard Overview](#dashboard-overview)
4. [Student Monitoring](#student-monitoring)
5. [Live Screen Viewing](#live-screen-viewing)
6. [Remote Classroom Controls](#remote-classroom-controls)
7. [Roster Management](#roster-management)
8. [Data & Privacy](#data--privacy)
9. [Admin Features](#admin-features)
10. [Chrome Extension](#chrome-extension)
11. [Troubleshooting](#troubleshooting)

---

## Overview

ClassPilot is a comprehensive classroom monitoring system designed for educational environments using managed Chromebooks. It provides teachers with real-time visibility into student activity while maintaining transparency and privacy.

### Key Features
- 📊 **Real-time Activity Monitoring** - See what students are browsing as it happens
- 🎥 **Live Screen Viewing** - Watch student screens via WebRTC with advanced controls
- 🎯 **Per-Student Targeting** - Apply controls to specific students or entire class
- 🔒 **Remote Classroom Control** - Lock screens, manage tabs, apply domain restrictions
- 📸 **Advanced Recording** - Capture screenshots and record screen activity
- 📱 **Shared Device Support** - Multiple students per Chromebook
- 🔐 **Privacy-First Design** - Transparent monitoring with clear consent
- 📈 **Website Duration Tracking** - Track time spent on websites

---

## Getting Started

### For Teachers

1. **Login** to the ClassPilot dashboard at your school's URL
2. **View Dashboard** - You'll immediately see all students in your class
3. **Install Extension** - Students must have the ClassPilot Chrome Extension installed (typically done by IT)

### For Students

1. **Extension Auto-Installs** - IT force-installs the ClassPilot extension on managed Chromebooks
2. **Sign in to Chrome** - Use your school Google account
3. **Extension Activates** - The extension automatically detects you and starts sending activity updates
4. **Disclosure Banner** - You'll see a notification that monitoring is active (transparency)

### First Time Setup

**Teachers:**
- Your IT administrator creates your account
- You receive login credentials via email
- Login and start monitoring immediately

**IT Administrators:**
- Create teacher accounts via Admin panel
- Force-install Chrome Extension via Google Admin Console
- Configure IP allowlist (optional) for dashboard access
- Set data retention policies

---

## Dashboard Overview

### Main View

The dashboard displays students in a **grid layout** with real-time activity cards.

#### Student Tile Information

Each student tile shows:
- **Student Name** and photo (if available)
- **Current Activity** - What website/tab they're viewing
- **Status Icon** - Online (🟢), Idle (🟡), Offline (⚫)
- **Camera Active** - Purple camera icon (📷) if camera is on
- **Lock Status** - Lock icon (🔒) if screen is locked
- **Selection Checkbox** - For per-student targeting
- **Live View Button** - Click the eye icon (👁️) to watch their screen

#### Activity Categories

Students are automatically grouped into:

1. **Off-Task** (Red) - Visiting non-educational sites or blocklist violations
2. **On-Task** (Green) - Visiting approved educational websites  
3. **Idle** (Yellow) - No activity for 30+ seconds
4. **Offline** (Gray) - Device not connected or heartbeat stopped

### Statistics Bar

At the top of the dashboard:
- 📊 **Total Students** - Number of students in class
- 🟢 **Online** - Currently active students
- 🟡 **Idle** - Inactive but connected
- ⚫ **Offline** - Disconnected devices
- 📷 **Camera Active** - Students with camera on
- 🔒 **Locked** - Students with locked screens

### Grade Tabs

Switch between different grade levels or class groups:
- Click grade tabs to filter students
- Add/remove grades via Settings
- Manage grade assignments in Roster Management

---

## Student Monitoring

### Real-Time Activity Tracking

ClassPilot automatically tracks:
- **Tab Titles** - The title of the active browser tab
- **URLs** - Full website address
- **Favicons** - Website icons for quick recognition
- **Timestamps** - When each activity occurred
- **Website Duration** - Time spent on each site

**Update Frequency:** Every 10 seconds

### Activity Details

**Click on any student tile** to open the **Student Drawer** with detailed information:

#### Student Information Tab
- Full name and student ID
- Device information
- Grade level
- Last activity timestamp
- Total session duration

#### Activity History Tab
- Complete browsing history for the session
- Website visit durations
- Chronological timeline
- Domain patterns

#### Website Duration Tab
- Aggregated time per website
- Top visited sites
- Time breakdown by domain
- Visual duration charts

### Camera Monitoring

When a student activates their camera (Zoom, Google Meet, etc.):
- 📷 **Purple camera icon** appears on their tile
- Real-time notification to teacher
- Automatic detection via browser API
- Privacy-aware: Only detects camera activation, not content

### Domain Blocklist Alerts

If a student visits a blocked website:
- ⚠️ **Red alert badge** on student tile
- Immediate notification to teacher
- Logged in activity history
- Can trigger automatic actions (if configured)

---

## Live Screen Viewing

### Starting a Live View

1. **Click the Eye Icon** (👁️) on any student tile
2. Extension sends screen share request to student
3. **Two capture modes:**
   - **Silent Capture** (Managed Chromebooks) - No prompt, instant streaming
   - **Picker Dialog** (Unmanaged devices) - Student sees picker, selects screen

4. Video appears in real-time on the student tile

### Video Controls

#### Basic Controls (On Tile)
- **Expand Button** - Open full-screen video portal
- **Stop Button** - End screen viewing session

#### Advanced Controls (Expanded View)

Click **Expand** to open the **Video Portal** with professional monitoring tools:

##### Zoom Controls
- **0.5x** - Zoom out to see more context
- **1x** - Normal view (default)
- **1.5x** - Moderate zoom
- **2x** - 2x magnification
- **3x** - Maximum zoom for detail viewing

##### Screenshot Capture
- Click **📸 Screenshot** button
- Instantly captures current frame as PNG
- **Auto-downloads** to your `~/Downloads` folder
- Filename: `screenshot-[student]-[timestamp].png`
- No file picker required - instant save

##### Screen Recording
- Click **🔴 Record** button to start recording
- **Duration counter** shows recording time
- Click **⏹️ Stop** to end recording
- Saves as WebM video file
- **Auto-downloads** to your `~/Downloads` folder
- Filename: `recording-[student]-[timestamp].webm`

##### Additional Controls
- **Fullscreen Mode** - Maximize video to entire screen
- **Picture-in-Picture** - Pop out video to floating window
- **Close** - Exit expanded view, return to tile

### Understanding Video Quality

**Resolution:** Up to 1280x720 (720p)  
**Frame Rate:** 15 FPS (smooth, bandwidth-efficient)  
**Latency:** ~1-2 seconds (real-time)

**Managed Chromebooks:**
- ✅ Silent capture (no student prompts)
- ✅ Instant streaming
- ✅ Requires Google Admin policy configuration

**Unmanaged Chromebooks:**
- ⚠️ Student sees screen picker dialog
- ⚠️ Must manually select screen/window
- ⚠️ Can deny request

---

## Remote Classroom Controls

### Per-Student Targeting

All remote controls support targeting specific students:

1. **Select Students** - Check boxes on student tiles
2. **Target Display** - Shows "Target: X selected" or "Target: All students"
3. **Apply Command** - Only affects selected students (or all if none selected)
4. **Clear Selection** - "Clear Selection" button to deselect all

**Selection Controls:**
- ☑️ **Select All** - Target entire class
- ❌ **Clear Selection** - Deselect everyone
- Selection count badge shows how many selected

### Remote Tab Control

#### Open Tabs
- **Button:** "Open Tab" in toolbar
- **Action:** Opens a specific URL on target students' devices
- **Use Cases:** 
  - Direct students to assignment page
  - Start class on same resource
  - Quick navigation to educational content

**How to Use:**
1. Select target students (or none for all)
2. Click "Open Tab"
3. Enter URL (e.g., `https://classroom.google.com`)
4. Click "Open"
5. New tab opens on target devices instantly

#### Close Tabs
- **Button:** "Close Tab" in toolbar
- **Action:** Closes the currently active tab on target devices
- **Use Cases:**
  - End distracting websites
  - Move students away from off-task content
  - Quick class-wide tab cleanup

**How to Use:**
1. Select target students
2. Click "Close Tab"
3. Confirm action
4. Active tab closes immediately

#### Lock/Unlock Screens

**Lock Screen:**
- **Button:** "Lock Screen" in toolbar
- **Action:** 
  - Restricts student to current tab only
  - Prevents creating new tabs
  - Blocks navigation away from current page
- **Visual:** 🔒 Lock icon on student tile
- **Use Cases:**
  - Focus students during test
  - Ensure attention during presentation
  - Prevent browsing during lecture

**Unlock Screen:**
- **Button:** "Unlock Screen" in toolbar
- **Action:** Removes restrictions, normal browsing resumes
- **Visual:** Lock icon disappears

**How to Use:**
1. Select students to lock
2. Click "Lock Screen"
3. Students are restricted to current tab
4. Click "Unlock Screen" when ready to restore access

### Apply Scenes

**Scenes** are predefined sets of allowed domains that restrict browsing to specific educational websites.

**Example Scene: "Math Class"**
- Allowed: `khanacademy.org`, `desmos.com`, `wolfram.com`
- Blocked: Everything else

**How to Use:**
1. Select target students
2. Click "Apply Scene"
3. Choose from preconfigured scenes
4. Students can only visit allowed domains
5. Attempts to visit other sites are blocked

**Use Cases:**
- Focus students on specific resources
- Create safe browsing environments
- Subject-specific website restrictions
- Prevent distraction during activities

### Student Groups

Organize students into groups for targeted instruction:

**Creating Groups:**
1. Go to "Groups" section
2. Click "Create Group"
3. Name the group (e.g., "Advanced Math", "Reading Group A")
4. Select students to include
5. Save group

**Using Groups:**
1. Click group name to select all members
2. Apply any remote control command
3. All group members receive the command

**Use Cases:**
- Differentiated instruction
- Small group activities
- Ability-level groupings
- Project teams

### Tab Limiting

Set maximum number of tabs students can have open:

**How to Configure:**
1. Click "Tab Limits" in Settings
2. Set maximum tabs per student (e.g., 5 tabs)
3. Apply to selected students or all
4. Students cannot open more than limit

**What Happens:**
- Student tries to open 6th tab (with limit of 5)
- Extension blocks the new tab
- Student sees notification: "Tab limit reached"
- Must close existing tab to open new one

**Use Cases:**
- Prevent tab overload
- Reduce distraction
- Improve device performance
- Keep students focused

---

## Roster Management

Access via **"Roster"** page in navigation.

### Managing Devices

**Add Device:**
1. Click "Add Device"
2. Enter device name (e.g., "Chromebook-05")
3. Enter device ID (automatically captured by extension)
4. Assign to grade level
5. Save

**Edit Device:**
1. Find device in list
2. Click "Edit"
3. Update name, ID, or grade
4. Save changes

**Delete Device:**
1. Find device in list
2. Click "Delete"
3. Confirm deletion
4. Device and associated data removed

### Managing Students

**Add Student:**
1. Click "Add Student"
2. Enter student name
3. Assign to device (one or multiple)
4. Set grade level
5. Save

**Shared Chromebook Support:**
- Assign **multiple students** to single device
- Extension auto-detects which student is signed in
- Activity tracked per student, not per device
- Seamless switching between students

**Edit Student:**
1. Find student in list
2. Click "Edit"
3. Update name, device assignment, or grade
4. Save changes

**Delete Student:**
1. Find student in list
2. Click "Delete"
3. Choose data retention option:
   - Delete student and all activity data
   - Delete student but keep anonymized data
4. Confirm deletion

### Grade-Level Filtering

Filter roster view by grade:
- Click grade filter dropdown
- Select specific grade
- View only students/devices in that grade

---

## Data & Privacy

### Privacy-First Design

ClassPilot is built with privacy as a core principle:

✅ **Transparent Monitoring**
- Students see disclosure banner when extension is active
- Clear notification that monitoring is occurring
- No hidden or secret tracking

✅ **Opt-In Screen Sharing**
- Live screen viewing requires explicit consent
- Student sees request before sharing (on unmanaged devices)
- Can deny screen share request
- Silent capture only on managed devices with admin policies

✅ **Minimal Data Collection**
- Only collects educational activity data
- No keystrokes or passwords captured
- No personal input data stored
- No camera/microphone content recorded

✅ **FERPA/COPPA Compliance**
- Designed to meet educational privacy standards
- Essential data only
- Clear disclosure and consent
- Parental/admin controls available

### Data Retention

**Configurable Retention Periods:**

Access via **Settings → Data Retention**

**Options:**
- 7 days
- 30 days
- 90 days
- 1 year
- Indefinite

**Automatic Cleanup:**
- Data older than retention period is automatically deleted
- Runs daily at midnight
- Irreversible deletion
- Activity logs, browsing history, and screenshots cleaned

**Export Before Deletion:**
1. Go to Data Retention settings
2. Click "Export Data"
3. Select date range
4. Download CSV (.csv) file
5. Contains all activity data in spreadsheet format

### What Data is Collected

**Per Activity Event (every 10 seconds):**
- Student ID
- Device ID
- Tab title
- URL visited
- Timestamp
- Favicon URL

**Session Data:**
- Login time
- Logout time
- Total session duration
- Device information

**NOT Collected:**
- Keystrokes or form inputs
- Passwords or credentials
- Personal messages or emails
- Camera or microphone content
- File contents
- Downloads

### IP Allowlist (Optional)

Restrict dashboard access to specific IP addresses:

**Enable IP Allowlist:**
1. Admin panel → Security Settings
2. Enable "IP Allowlist"
3. Add allowed IP addresses (e.g., school network)
4. Save

**Effect:**
- Only connections from allowed IPs can access dashboard
- Blocks unauthorized access from outside school network
- Additional security layer

---

## Admin Features

Access via **Admin Panel** (admin accounts only)

### Teacher Account Management

**Create Teacher Account:**
1. Click "Add Teacher"
2. Enter teacher information:
   - Full name
   - Email address
   - Username
   - Temporary password
3. Assign role (Teacher or Admin)
4. Save
5. Teacher receives login credentials via email

**View All Teachers:**
- List of all teacher accounts
- See login status and last activity
- Filter by role or status

**Delete Teacher Account:**
1. Find teacher in list
2. Click "Delete"
3. Confirm deletion
4. Account and associated preferences removed
5. Student data remains intact

### System Settings

**School Information:**
- School name
- Logo upload
- Contact information

**Security Settings:**
- IP allowlist configuration
- Session timeout duration
- Password requirements

**Data Settings:**
- Default data retention period
- Automatic cleanup schedule
- Export format preferences

**Extension Settings:**
- Heartbeat interval (default: 10 seconds)
- Idle timeout (default: 30 seconds)
- Domain blocklist
- Allowed domain whitelist

---

## Chrome Extension

### How It Works

The ClassPilot Chrome Extension runs silently in the background on student Chromebooks.

**Architecture:**
- **Manifest V3** - Modern, secure extension format
- **Service Worker** - Persistent background process
- **Content Scripts** - Inject into web pages for activity tracking
- **Offscreen Document** - WebRTC screen sharing handler

### Automatic Student Detection

**Google Workspace Integration:**
1. Extension uses Chrome Identity API
2. Detects student's Google Workspace email
3. Automatically registers device with email
4. No manual configuration needed

**What Students See:**
- Extension icon in toolbar (can be hidden by admin)
- Disclosure banner: "This device is being monitored"
- Screen share picker (on unmanaged devices only)

### Heartbeat System

The extension sends activity updates every **10 seconds**:

**What's Sent:**
- Current tab title
- Current URL
- Timestamp
- Student identifier
- Device identifier

**Reliability Features:**
- `chrome.alarms` API for persistent heartbeats
- Automatic reconnection with exponential backoff
- Survives service worker sleep/wake cycles
- Network failure handling

### Activity Tracking

**Tab Navigation:**
- Detects when student switches tabs
- Tracks active tab changes
- Records navigation events

**Camera Detection:**
- Non-intrusive API wrapper
- Detects `getUserMedia()` calls
- No access to camera content
- Only knows camera is active/inactive

**Browsing Activity:**
- Uses `chrome.webNavigation` API
- Tracks page loads and navigations
- Records URL visits
- Captures page titles

### WebRTC Screen Sharing

**Two Capture Modes:**

**1. Silent Tab Capture** (Managed Chromebooks)
- Uses `chrome.tabCapture` API
- No student prompt required
- Requires Google Admin policy: "Allow tab capture"
- Instant streaming to teacher

**2. Screen Picker** (Fallback)
- Uses `getDisplayMedia()` API
- Student sees picker dialog
- Must select screen/window/tab
- Can deny request

**Connection Process:**
1. Teacher clicks "Watch Screen"
2. Extension receives request via WebSocket
3. Creates offscreen document for WebRTC
4. Attempts silent capture (if managed)
5. Falls back to picker if silent fails
6. Establishes peer connection to teacher
7. Streams video in real-time

**Network:**
- Uses STUN servers for NAT traversal
- Peer-to-peer WebRTC connection
- Low latency (~1-2 seconds)
- Adaptive bitrate

### Installation

**For IT Administrators:**

1. **Package Extension:**
   - Download ClassPilot extension folder
   - Create `.zip` file or `.crx` package

2. **Google Admin Console:**
   - Navigate to Devices → Chrome → Apps & Extensions
   - Click "Add app or extension"
   - Upload extension package
   - Set install policy to "Force install"
   - Apply to student organizational units

3. **Configure Policies:**
   - Enable silent tab capture policy (optional)
   - Set extension settings via managed storage
   - Configure server URL

4. **Deploy:**
   - Push to student Chromebooks
   - Extension auto-installs on next Chrome sync
   - Students do not need to take action

**Manual Installation (Development/Testing):**
1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select extension folder
5. Extension activates immediately

### Troubleshooting Extension

**Extension Not Appearing:**
- Check Chrome sync is enabled
- Verify student is signed in with Google Workspace account
- Check Google Admin force-install policy is applied
- Wait 5-10 minutes for policy propagation

**Heartbeats Not Sending:**
- Check internet connection
- Verify server URL is correct
- Check browser console for errors (`chrome://extensions` → Details → Inspect views → service worker)
- Reload extension

**Silent Capture Not Working:**
- Verify Google Admin policy "Allow tab capture" is enabled
- Check device is enrolled in Google Admin
- Extension will automatically fall back to picker

**Screen Share Picker Not Appearing:**
- Browser may have blocked popup
- Check notification permissions
- Verify extension has screen capture permissions

---

## Troubleshooting

### Common Issues

#### Students Not Appearing on Dashboard

**Possible Causes:**
1. Extension not installed on student device
2. Student not signed in to Chrome with Google Workspace account
3. Network connectivity issues
4. Server connection problems

**Solutions:**
1. Verify extension is installed: `chrome://extensions`
2. Check student is signed in with school Google account
3. Test internet connection on student device
4. Check server status
5. Wait 10 seconds for first heartbeat to send

#### Live Screen View Not Working

**Possible Causes:**
1. Student denied screen share request
2. WebRTC connection blocked by firewall
3. Offscreen document not created
4. Network connectivity issues

**Solutions:**
1. Ask student to accept screen share request
2. Check firewall allows WebRTC traffic (STUN/TURN ports)
3. Reload extension on student device
4. Try again - connection may have timed out
5. Check browser console for WebRTC errors

#### Video Quality Poor

**Possible Causes:**
1. Low bandwidth network
2. High network latency
3. Device performance limitations

**Solutions:**
1. Check network speed (need 2+ Mbps per stream)
2. Reduce number of simultaneous live views
3. Ask student to close unnecessary tabs/apps
4. Use lower zoom level (0.5x or 1x)

#### Students Shown as Offline

**Possible Causes:**
1. Device actually offline
2. Extension disabled or removed
3. Heartbeat system failure
4. Network connectivity intermittent

**Solutions:**
1. Check device has internet connection
2. Verify extension is enabled in `chrome://extensions`
3. Reload extension
4. Check for Chrome browser updates
5. Restart Chromebook

#### Screenshots/Recordings Not Downloading

**Possible Causes:**
1. Browser blocked automatic downloads
2. Downloads folder permissions
3. Storage space full

**Solutions:**
1. Allow automatic downloads in Chrome settings
2. Check popup blocker settings
3. Verify sufficient storage space
4. Try again - may be temporary issue
5. Check Downloads folder permissions

#### Extension Shows Errors

**Expected Behaviors (Not Errors):**
- "Offer received before screen share started" - Normal
- "User denied screen share" - Student action, expected
- "Silent tab capture not available" - Normal on unmanaged devices
- "ICE candidate queued" - Normal WebRTC timing

**Real Errors:**
- "Unexpected signaling error" - Contact support
- "Connection failed" - Network issue
- "Capture failed" - Permission/device issue

**Check:**
1. Go to `chrome://extensions`
2. Click "Details" on ClassPilot
3. Click "Errors" button (if present)
4. Review error messages
5. Reload extension to clear expected behaviors

### Getting Help

**Teacher Support:**
- Contact your IT administrator
- Check ClassPilot documentation
- Review error messages in browser console

**IT Administrator Support:**
- Review server logs
- Check Google Admin policies
- Verify network configuration
- Contact ClassPilot support team

**Student Issues:**
- Direct students to contact teacher
- Teacher contacts IT administrator
- IT administrator troubleshoots extension

---

## Best Practices

### For Teachers

✅ **Transparency**
- Inform students monitoring is active
- Explain why monitoring helps learning
- Respect student privacy

✅ **Effective Monitoring**
- Use live view sparingly (focused supervision)
- Review activity history for patterns
- Address off-task behavior constructively
- Use remote controls purposefully

✅ **Data Management**
- Export important data before retention period expires
- Review data retention settings regularly
- Delete data when no longer needed

✅ **Remote Controls**
- Use per-student targeting when possible
- Communicate before locking screens
- Unlock screens when activity complete
- Use scenes for structured activities

### For IT Administrators

✅ **Deployment**
- Test extension on pilot devices first
- Configure Google Admin policies correctly
- Set appropriate data retention defaults
- Document server URL and credentials

✅ **Security**
- Enable IP allowlist for dashboard
- Use strong passwords for teacher accounts
- Regularly review access logs
- Keep extension updated

✅ **Support**
- Provide teacher training
- Create school-specific documentation
- Establish clear escalation process
- Monitor system performance

### For Students

✅ **Compliance**
- Keep extension enabled
- Stay signed in with school account
- Report technical issues to teacher
- Use devices appropriately

---

## Technical Specifications

### System Requirements

**Teacher Dashboard:**
- Modern web browser (Chrome, Firefox, Safari, Edge)
- Internet connection (2+ Mbps recommended)
- Display resolution: 1280x720 minimum

**Student Chromebooks:**
- Chrome OS (managed or unmanaged)
- Chrome browser version 90+
- Internet connection (1+ Mbps per device)
- Google Workspace account

**Server:**
- Node.js 24+
- PostgreSQL database
- WebSocket support
- HTTPS/TLS certificate

### Network Requirements

**Ports:**
- 443 (HTTPS) - Dashboard access
- 443 (WSS) - WebSocket connections
- STUN/TURN - WebRTC traffic (UDP/TCP)

**Bandwidth:**
- Per student: ~0.5 Mbps (monitoring only)
- Per live view: ~2 Mbps (video streaming)
- Recommended: 5+ Mbps per teacher station

**Firewall:**
- Allow WebSocket connections
- Allow WebRTC traffic
- Whitelist ClassPilot server domain

### Data Storage

**Per Student/Day:**
- ~5 MB activity data
- ~50 MB with screenshots (if using)
- ~500 MB with recordings (if using)

**Database:**
- PostgreSQL with automatic cleanup
- Configurable retention periods
- Indexed for fast queries

---

## Compliance & Legal

### Privacy Compliance

ClassPilot is designed to support compliance with:
- **FERPA** (Family Educational Rights and Privacy Act)
- **COPPA** (Children's Online Privacy Protection Act)
- **State education privacy laws**

**School Responsibilities:**
1. Obtain necessary consent from parents/guardians
2. Provide notice of monitoring to students
3. Configure appropriate data retention
4. Ensure authorized access only
5. Follow local/state privacy regulations

### Terms of Use

**Acceptable Use:**
✅ Monitoring for educational purposes
✅ Ensuring student safety online
✅ Supporting classroom instruction
✅ Identifying technology issues

**Prohibited Use:**
❌ Monitoring outside school hours (unless consented)
❌ Sharing student data with unauthorized parties
❌ Using data for non-educational purposes
❌ Accessing personal student information

### Data Protection

**Security Measures:**
- Encrypted data transmission (HTTPS/WSS)
- Secure password storage (bcrypt)
- Session management with expiration
- Role-based access control
- Audit logging

**Student Rights:**
- Right to know monitoring is active
- Right to access their data (via teacher/parent)
- Right to data deletion (per retention policy)
- Right to refuse screen sharing (on unmanaged devices)

---

## Appendix

### Glossary

**Activity Event** - A single data point capturing student's active tab and URL at a moment in time

**Heartbeat** - Regular signal from extension indicating student device is online and active

**ICE Candidate** - Network path information used to establish WebRTC peer connection

**Managed Chromebook** - Device enrolled in Google Workspace Admin and controlled by school policies

**Offscreen Document** - Hidden webpage used by extension to handle WebRTC connections

**Peer Connection** - Direct WebRTC connection between student device and teacher dashboard

**Scene** - Predefined set of allowed domains for restricting student browsing

**Service Worker** - Background script in extension that runs independently of browser tabs

**Silent Capture** - Screen sharing without user prompt, enabled on managed Chromebooks with policies

**WebRTC** - Web Real-Time Communication, technology enabling live video streaming

### Keyboard Shortcuts

**Dashboard:**
- `Ctrl/Cmd + Shift + S` - Select all students
- `Ctrl/Cmd + Shift + D` - Deselect all students
- `Esc` - Close student drawer or video portal

**Video Portal:**
- `F` - Toggle fullscreen
- `+` - Zoom in
- `-` - Zoom out
- `S` - Take screenshot
- `R` - Start/stop recording
- `Esc` - Close portal

### Support Resources

**Documentation:**
- User Guide (this document)
- Extension Error Handling Guide
- API Documentation
- Deployment Guide

**Contact:**
- School IT Support: [Your IT department]
- ClassPilot Support: [Support email]
- Emergency Contact: [Emergency contact]

---

**Last Updated:** January 2025  
**Version:** 1.0  
**Copyright:** ClassPilot Team

---

*This guide is provided for educational purposes. Schools are responsible for ensuring compliance with all applicable privacy laws and regulations.*

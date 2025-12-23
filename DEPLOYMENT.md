# Deployment Guide - ClassPilot

Complete guide for deploying the Teacher Dashboard and Chrome Extension to production.

## Prerequisites

- Replit account (for hosting the web app)
- Google Workspace for Education account with Admin access
- Managed Chromebooks enrolled in your Google domain

## Part 1: Deploy Teacher Dashboard on Replit

### 1.1 Environment Variables

In your Replit project, configure the following secrets:

1. Go to **Tools** → **Secrets** in Replit
2. Add the following secrets:

| Secret Name | Value | Purpose |
|------------|-------|---------|
| `SESSION_SECRET` | 32+ byte random string | Required in production - used for session encryption |
| `STUDENT_TOKEN_SECRET` | 32+ byte random string | Required in production - signs student JWT tokens |
| `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY` | 32-byte base64 key | Required in production - encrypts OAuth tokens |
| `WS_SHARED_KEY` | Generate a strong random key | WebSocket authentication (optional) |
| `SCHOOL_ID` | Your school identifier (e.g., `lincoln-high`) | School identification |
| `HEARTBEAT_MIN_PERSIST_SECONDS` | `15` (default) | Minimum seconds between persisted heartbeats per device |

To generate a strong key for `WS_SHARED_KEY`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

To generate secrets for `SESSION_SECRET` or `STUDENT_TOKEN_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

To generate `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 1.2 Deploy to Production

1. In Replit, click **Deploy** (top right)
2. Choose **Autoscale** or **Reserved VM** deployment
3. Wait for deployment to complete
4. Note your production URL (e.g., `https://your-app.replit.app`)

### 1.3 Configure Production Settings

1. Access your deployed app
2. Log in with default credentials:
   - Username: `teacher`
   - Password: `teacher123`
3. Go to **Settings** page
4. Update the following:
   - **School Name**: Your school's name
   - **WebSocket Shared Key**: Match the `WS_SHARED_KEY` secret
   - **Data Retention**: Adjust hours as needed (default: 24)
   - **Change the default password** (important!)

### 1.4 Create Additional Teacher Accounts

Currently, the system supports one teacher account. To add more accounts, you can modify the initialization script or add a user management page (future enhancement).

## Part 2: Prepare Chrome Extension for Deployment

### 2.1 Update Extension Configuration

1. Navigate to the `extension` directory
2. Open `service-worker.js`
3. Update the `CONFIG` object with your production URL:

```javascript
let CONFIG = {
  serverUrl: 'https://your-app.replit.app', // Replace with your Replit URL
  heartbeatInterval: 10000, // 10 seconds
  schoolId: 'your-school-id', // Match the school ID from settings
  // ...
};
```

### 2.2 Add Extension Icons

The extension needs icons in the `extension/icons/` directory:
- `icon16.png` - 16x16 pixels
- `icon48.png` - 48x48 pixels
- `icon128.png` - 128x128 pixels

You can:
1. Use an online icon generator (https://www.favicon-generator.org/)
2. Design custom icons in Figma/Canva
3. Use a monitor/education-themed icon from free icon libraries

Recommended design:
- Blue color scheme (#3b82f6)
- Monitor or screen icon
- Simple and clear at small sizes

### 2.3 Create Extension ZIP Package

Navigate to the extension directory and create a ZIP file:

**On Mac/Linux:**
```bash
cd extension
zip -r ../classpilot.zip . -x "*.DS_Store" -x "README.md"
```

**On Windows:**
1. Navigate to the `extension` folder
2. Select all files (manifest.json, service-worker.js, popup.html, popup.js, content.js, icons folder)
3. Right-click → Send to → Compressed (zipped) folder
4. Name it `classpilot.zip`

## Part 3: Deploy Extension via Google Admin Console

### 3.1 Upload Extension

1. Log in to [Google Admin Console](https://admin.google.com)
2. Navigate to: **Devices** → **Chrome** → **Apps & Extensions**
3. Click **Chrome apps & extensions** (left sidebar)
4. Select your organizational unit:
   - Students (all students)
   - Or specific OUs (e.g., Grade 10, Class 3A)
5. Click the **+** (Add) button in the bottom right
6. Choose **Upload private app**
7. Upload your `classpilot.zip` file
8. Fill in the details:
   - **Name**: ClassPilot
   - **Description**: Privacy-aware classroom monitoring extension
   - **Category**: Education

### 3.2 Configure Installation Policy

After uploading:

1. Find "ClassPilot" in your extensions list
2. Click on it
3. Set **Installation** to: **Force install**
4. Set **Permission to run** to: **Allow**
5. Configure **URL patterns** (optional):
   - Leave as default (`<all_urls>`) for full monitoring
   - Or restrict to specific domains if needed

### 3.3 Set Extension Policy (Optional)

To pre-configure the server URL for students:

1. In the extension settings, click **Configure**
2. Add the following JSON policy:

```json
{
  "serverUrl": {
    "Value": "https://your-app.replit.app"
  },
  "schoolId": {
    "Value": "your-school-id"
  }
}
```

This prevents students from needing to configure the server manually (future enhancement).

### 3.4 Save and Publish

1. Click **Save**
2. The extension will now be force-installed on all Chromebooks in the selected organizational unit
3. Deployment may take up to 24 hours (usually faster)

## Part 4: Test the Deployment

### 4.1 Test on a Chromebook

1. Log in to a managed Chromebook with a student account
2. Wait for the extension to auto-install (check `chrome://extensions`)
3. Click the extension icon in the toolbar
4. Enter student name and class ID
5. Click "Connect to Classroom"
6. Verify the badge shows a green dot (●)

### 4.2 Verify in Teacher Dashboard

1. Open your deployed app in a browser
2. Log in as teacher
3. Navigate to the Dashboard
4. You should see the test student appear within 10 seconds
5. Check that:
   - Student name appears correctly
   - Active tab title shows
   - Active tab URL shows
   - Status is "Online" (green dot)

### 4.3 Test Screen Sharing

1. On the student Chromebook, click the extension icon
2. Click "Share My Screen"
3. Select a window/tab to share
4. Verify:
   - Red "Sharing Active" indicator appears
   - Extension badge shows red circle (◉)
   - Teacher dashboard shows "Sharing" badge on student tile
5. Click "Stop Sharing" to end
6. Verify indicators update accordingly

## Part 5: Student Communication

### 5.1 Privacy Notice to Students/Parents

Before deploying, inform students and parents about the monitoring:

**Sample Email/Notice:**

> Dear Students and Parents,
>
> To support effective classroom management, our school is implementing a new classroom monitoring system called "ClassPilot" on school-managed Chromebooks.
>
> **What is monitored:**
> - Active browser tab titles and URLs during class time
> - Timestamps of web activity
> - Website icons (favicons)
>
> **What is NOT monitored:**
> - Keystrokes or typed content
> - Microphone or camera (unless screen sharing is explicitly enabled by the student)
> - Private messages or passwords
> - Activity in incognito/private windows
>
> **Screen Sharing (Optional):**
> - Students may be asked to share their screen with the teacher
> - This requires the student to click "Share My Screen" button
> - A visible red indicator shows when sharing is active
> - Students can stop sharing at any time
>
> **Privacy & Data Retention:**
> - All monitoring is visible to students through the extension
> - Activity data is automatically deleted after 24 hours
> - The system is FERPA and COPPA compliant
>
> This system helps teachers ensure students stay on task during class while maintaining transparency about what is monitored.
>
> If you have questions, please contact [admin contact].

### 5.2 Student Instructions

Provide students with a quick reference:

**What students see:**
1. An extension icon appears in their Chrome toolbar
2. Clicking it shows their connection status
3. A yellow banner clearly states "Monitoring In Effect"
4. They can see exactly what's being shared (tab title and URL)
5. A "What's being collected?" link provides full privacy information

**If asked to share their screen:**
1. Teacher will request screen sharing
2. Student clicks "Share My Screen" button
3. Student chooses which window/tab to share
4. Red indicator shows "Sharing Active"
5. Student clicks "Stop Sharing" to end

## Part 6: Monitoring & Maintenance

### 6.1 Check System Health

Regularly check:
- Replit deployment is running
- WebSocket connection is stable (check dashboard connection status)
- Students are appearing in the dashboard
- Data retention cleanup is running (check logs)

### 6.2 Export Activity Data

For compliance or reporting:
1. Go to Settings page
2. Click "Export Activity CSV"
3. Save CSV file with student activity data
4. Store securely according to your data retention policies

### 6.3 Roster Management

To organize students by class:
1. Create a CSV file with format:
   ```
   studentName,deviceId,classId
   John Doe,device-001,class-101
   Jane Smith,device-002,class-101
   ```
2. Go to Settings → Class Roster Upload
3. Upload the CSV file
4. Use `/class/{classId}` URL to filter dashboard by class

### 6.4 Update Extension

To update the extension after changes:
1. Update extension files locally
2. Increment version in `manifest.json`
3. Create new ZIP package
4. Upload to Google Admin Console
5. Extension will auto-update on Chromebooks (may take 24 hours)

## Part 7: Troubleshooting

### Students Not Appearing in Dashboard

**Check:**
1. Extension is installed on Chromebook (`chrome://extensions`)
2. Student completed setup (entered name and class)
3. Extension badge shows green dot (●)
4. Server URL in extension matches deployed URL
5. Chromebook has internet connection

**Fix:**
- Have student re-open extension popup
- Check browser console (F12) for errors
- Verify firewall isn't blocking requests
- Restart Chromebook

### WebSocket Connection Issues

**Symptoms:**
- Dashboard shows "Disconnected"
- Real-time updates not working

**Fix:**
1. Check Replit deployment is running
2. Verify WebSocket endpoint `/ws` is accessible
3. Check browser console for WebSocket errors
4. Ensure HTTPS/WSS protocol is correct
5. Restart workflow in Replit if needed

### Screen Sharing Not Working

**Check:**
1. Student clicked "Share My Screen" button
2. Student granted permissions in Chrome dialog
3. WebSocket connection is active
4. WebRTC signaling is working (check console logs)

**Fix:**
- Ensure student uses physical button click (user gesture required)
- Check Chrome permissions for screen capture
- Verify WebSocket is connected
- Test with simple tab sharing first

### Data Not Being Cleaned Up

**Check:**
1. Retention hours setting in Settings page
2. Server logs for cleanup messages
3. Time since last cleanup run (runs hourly)

**Fix:**
- Verify cleanup cron is running (check server logs)
- Manually trigger by restarting the workflow
- Check retention hours setting is valid number

## Part 8: Security Best Practices

### 8.1 Production Security Checklist

- [ ] Changed default teacher password
- [ ] Set strong SESSION_SECRET (auto-generated in Replit)
- [ ] Set strong WS_SHARED_KEY
- [ ] Configured appropriate data retention period
- [ ] Informed students/parents about monitoring
- [ ] Tested on non-production Chromebooks first
- [ ] Documented admin procedures
- [ ] Set up regular data exports for compliance
- [ ] Reviewed blocked domains list
- [ ] Ensured HTTPS is enabled (automatic on Replit)

### 8.2 Ongoing Security

- Regularly review activity exports for anomalies
- Monitor for unauthorized access attempts (check server logs)
- Keep extension updated with security patches
- Review and update blocked domains list
- Audit consent logs for screen sharing events
- Ensure compliance with school privacy policies

## Part 9: Future Enhancements

Potential improvements for future versions:

1. **Multi-Teacher Support**: User management with role-based access
2. **PostgreSQL Database**: Swap MemStorage for persistent PostgreSQL
3. **Advanced Analytics**: Charts and graphs for student engagement
4. **Mobile App**: iOS/Android app for teachers
5. **Automated Alerts**: Notify teachers of blocked domain access
6. **Schedule-Based Monitoring**: Only monitor during class hours
7. **Student Dashboard**: Let students view their own activity
8. **Integration with LMS**: Connect with Google Classroom, Canvas, etc.

## Support

For issues not covered in this guide:
1. Check application logs in Replit
2. Review browser console on student Chromebooks
3. Verify Google Admin Console deployment settings
4. Consult the main README.md and extension/README.md
5. Check replit.md for architecture details

---

**Deployed successfully?** You should now have:
- ✅ Teacher dashboard accessible via Replit URL
- ✅ Extension force-installed on managed Chromebooks
- ✅ Students appearing in real-time dashboard
- ✅ Screen sharing working on-demand
- ✅ Privacy notices distributed to students/parents

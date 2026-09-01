# Historical Prototype Deployment Guide - ClassPilot

> **Production stop:** the Replit dashboard/server instructions in this document
> describe the retired ClassPilot prototype. They must not be used for a
> SchoolPilot production deployment. The production API and web app are deployed
> only from the sibling SchoolPilot repository by following its `CLAUDE.md` and
> `docs/CLASSPILOT_2_7_1_RELEASE.md` runbooks. This repository publishes only the
> ClassPilot Chrome extension. There are no production default credentials.
>
> For 2.8.1, upload only `dist/ClassPilot-v2.8.1.zip` produced from the clean,
> tagged, reviewed commit by `./extension/package-extension.sh`. The matching
> `dist/ClassPilot-v2.8.1.zip.sha256` record, commit SHA, CI evidence, and exact
> uploaded archive must be retained. Never create or upload a ZIP manually.
> Existing 2.7.9 and 2.8.0 archives are obsolete because they do not contain
> the complete school-configured authentication pass-through and independent
> heartbeat/control/screenshot lane behavior. They must not be submitted.
> Submit with deferred publishing. Validate that exact package on at least two
> controlled Chromebooks using the production school policy before submission,
> test again after review, and publish only when the school-wide auto-update is
> ready to begin.
>
> The paired SchoolPilot deployment must land first with support for
> `restrictionAuthPassThroughV1`, while that capability remains disabled. Keep
> authentication-policy projection off throughout Chrome Web Store review and
> mixed-version fleet saturation. Enable it for a controlled school only after
> recently active Chromebooks report 2.8.1 and both the raw and accepted
> capability. Keep the independent active-preview capability under its own
> rollout policy.

The material below is retained solely to explain the retired prototype and is
not an operator runbook.

## Historical prototype prerequisites (not production)

- Replit account (for hosting the web app)
- Google Workspace for Education account with Admin access
- Managed Chromebooks enrolled in your Google domain

## Part 1: Retired Replit prototype (do not deploy)

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
| `REDIS_URL` | `redis://user:pass@host:6379` | Optional Redis pub/sub for multi-instance WebSockets |
| `REDIS_PREFIX` | `classpilot` | Optional Redis channel prefix for WebSocket fanout |
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

### 1.3 Historical prototype settings

The retired prototype once used bootstrap credentials. Those credentials have
been removed from this document and must never be assumed to exist in any
environment. Production identity and role administration belongs to
SchoolPilot.

For an isolated historical development instance only, authenticate through its
configured development identity and then update:

1. Go to **Settings**.
2. Update the following:
   - **School Name**: Your school's name
   - **WebSocket Shared Key**: Match the `WS_SHARED_KEY` secret
   - **Activity-History Retention**: Set 1–365 whole days (default: 30 days / 720 hours)

### 1.4 Create Additional Teacher Accounts

Currently, the system supports one teacher account. To add more accounts, you can modify the initialization script or add a user management page (future enhancement).

## Part 2: Prepare Chrome Extension for Deployment

### 2.1 Update Extension Configuration

1. Navigate to the `extension` directory
2. Prefer **managed policy** to set `serverUrl` (see below). Alternatively, inject a build-time override in `extension/config.js`:

```javascript
// extension/config.js
globalThis.CLASSPILOT_SERVER_URL = "https://your-app.replit.app";
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

### 2.3 Build the canonical 2.8.1 release artifact

Start from a clean, tagged, reviewed 2.8.1 commit at this repository's root.
The reviewed source must contain the auth-gate presence foundation, Kiosk mode
presentation, legacy exact-bound deferred-restriction marker, school-configured
live and deferred authentication pass-through, independent heartbeat/control/
screenshot lanes, and exact-authority active-class screenshot cadence together.
A narrower 2.7.9 or 2.8.0 archive is not releasable.
Run the complete source gates first, then build and verify the canonical archive:

```bash
npm run check
npm test
npm run test:extension:chrome
npm run build
./extension/package-extension.sh
npm run test:extension:package
node scripts/verify-extension-package.mjs dist/ClassPilot-v2.8.1.zip --verify-only
```

Confirm the generated SHA-256 record matches the exact archive being uploaded.
Retain the tag, commit SHA, archive, hash, and CI evidence. Do not use an
unversioned compatibility copy as the release record, and do not create an
archive with Explorer, PowerShell, or `zip` directly.

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
7. Upload the retained `dist/ClassPilot-v2.8.1.zip` whose SHA-256 was verified
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

### 3.3 Set Extension Policy (Recommended)

To pre-configure the server URL for students (recommended):

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

### 4.3 Test Active-Class Screenshot Cadence

1. Keep `screenshotActiveObservationCadenceV1` disabled until the controlled
   Chromebook has updated to 2.8.1 and reports the raw capability.
2. Open the exact class view as an authorized teacher or administrator, enable
   the capability only for the controlled school, and confirm a fresh preview
   arrives about every five seconds without overlapping uploads.
3. Switch away from that class view and confirm the short-lived rapid grant is
   revoked or expires locally and capture returns to the 30-second background
   cadence. Switching students, sessions, classes, or authentication contexts
   must never reuse the prior rapid schedule or pixels.
4. Exercise a `429` and screenshot-store `503`. Each rapid capture may make only
   one upload attempt; `429` must enter the existing backoff and neither failure
   may create a queued retry burst.
5. Roll back by disabling the capability. Version 2.8.1 must continue the
   existing 30-second tracking-window cadence without an extension rollback.

### 4.4 Test restricted student sign-in

1. Keep `restrictionAuthPassThroughV1` disabled until the controlled
   Chromebook reports 2.8.1 plus the raw and accepted capability.
2. Configure the school's Google, Clever, and any required district provider
   in SchoolPilot while projection remains off. Confirm every start URL and
   exact/subdomain host rule, then resolve block-policy warnings.
3. Enable the capability for the controlled school and test a cold deferred
   Clever → Google Accounts → Clever callback → destination flow. Repeat with
   direct Google sign-in, a live destination that redirects to sign-in, and the
   custom provider when configured.
4. During each flow, verify the Dashboard continues to receive heartbeats,
   shows **Signing in** rather than stale, and receives a new-revision passive
   preview within the acceptance window. A screenshot `429` or delayed tab API
   must not create a heartbeat gap.
5. Restart the MV3 worker during each authentication phase and exercise an IdP
   popup plus a second window. The active sign-in tab must survive tab-limit
   cleanup without being counted as the learning destination or stealing focus.
6. Verify cancellation, five-minute timeout, bounded retry, restriction
   removal, sign-out, and student/session/school/policy transitions clear the
   exact attempt. Attention and school/teacher blocks must still win.
7. Disable the capability to roll back policy projection before changing any
   extension deployment. Clear active restrictions for students who must
   authenticate while rollback is in effect.

### 4.5 Test Screen Sharing

1. From an authorized teacher dashboard, request Live View for the exact test
   student and active teaching session.
2. On a policy-installed managed Chromebook, verify the authorized stream starts
   without a student picker. On an unmanaged test device, complete Chrome's
   required tab/screen picker.
3. Verify the student-facing sharing indicator and the teacher dashboard's Live
   View state both appear.
4. Stop Live View from the teacher dashboard and verify the media tracks stop on
   the Chromebook. Repeat after changing the signed-in student/session and
   confirm the old negotiation cannot resume.
5. Validate both the direct ICE path and the configured TURN/TURNS fallback. A
   Live View stream is not recorded by the extension or SchoolPilot servers.
   If the dashboard's explicit local screenshot/recording controls are used,
   verify the school applies its notice, access, retention, and deletion policy
   to the downloaded file.

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
> - Bounded open-tab state needed for authorized classroom controls
> - Tracking-window active-tab thumbnails about every 5 seconds only while an
>   authorized teacher or administrator has the exact class view visible, and
>   about every 30 seconds otherwise while school-managed monitoring remains
>   active; SchoolPilot retains class-bound images and discards
>   gap/student-session pixels
> - One exact-tab safety image when an authorized safety action requests it
> - Classroom communications that a student or teacher chooses to send
> - Website content visibly rendered in an authorized thumbnail, safety image,
>   or temporary Live View, which can include an open message, email, or file
>
> **What is NOT monitored:**
> - Keystrokes or typed content
> - Microphone or camera audio/video
> - Passwords or messages read directly through page or account APIs
> - Activity in incognito/private windows
>
> **Live View:**
> - An authorized teacher may request a temporary Live View for the exact
>   student and teaching session
> - Managed, policy-installed Chromebooks can start the authorized stream
>   without a student picker; unmanaged devices use Chrome's picker
> - The extension displays a sharing indicator while the stream is active
> - Live View media is not recorded by the extension or SchoolPilot servers;
>   an authorized teacher can explicitly save a local recording or still image,
>   which the school controls
> - The temporary stream can display visible website content on the shared tab
>   or screen
>
> **Privacy & Data Retention:**
> - All monitoring is visible to students through the extension
> - The school setting governs heartbeat history and related report detail;
>   ambient thumbnails, safety evidence, communications, account/audit records,
>   and teacher-downloaded files follow separate policies
> - The school remains responsible for applicable notices, consent decisions,
>   and local privacy requirements
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

**When an authorized teacher starts Live View:**
1. The extension verifies the exact school, student, student session, and Live
   View negotiation before starting media.
2. Managed Chromebooks start the authorized stream without a picker; unmanaged
   devices use Chrome's required picker.
3. A visible indicator shows while sharing is active.
4. The stream stops when the teacher ends it or when its authority/session
   changes. The extension and SchoolPilot servers do not record it; an
   authorized teacher can explicitly save a local recording or still image,
   which the school controls.

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

Use SchoolPilot's Rosters surface to create or import school student records and
class memberships. The roster is not a student-to-device assignment surface:
do not add a `deviceId` column to student create/edit or CSV workflows.
Chromebook enrollment, extension health, and managed-device status remain in the
separate Chromebook/device surface.

### 6.4 Update Extension

To update the extension after changes:
1. Land the reviewed changes and obtain green paired SchoolPilot/ClassPilot CI.
2. Tag the clean ClassPilot release commit and confirm the live Store version.
3. Run the complete gates and `./extension/package-extension.sh` from the
   repository root.
4. Verify and retain `dist/ClassPilot-v2.8.1.zip`, its SHA-256, source/ZIP byte
   comparison, and unpacked integration evidence.
5. Validate that exact archive on at least two controlled Chromebooks using the
   production school configuration, then submit it with deferred publishing.
6. After review passes, repeat the controlled-device check and publish. The
   single managed school then updates automatically; expect a brief mixed-version
   period for offline or delayed Chromebooks.

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
1. The teacher is authorized for the exact student and active teaching session.
2. The ClassPilot WebSocket is authenticated and the current client accepted
   `liveViewIceServersV1`.
3. The server returned unexpired ICE credentials and signaling uses the current
   negotiation ID.
4. On unmanaged devices only, the user completed Chrome's required capture
   picker. Managed policy-installed Chromebooks do not depend on that picker.

**Fix:**
- End the failed negotiation and start a fresh exact-session Live View request.
- Verify both TURN nodes, TURN/TCP, and TURNS/443 with the live validation
  procedure before enabling the capability globally.
- Confirm an identity/session change stops the old media tracks and rejects its
  stale signaling frames.

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
- Review authorized Live View lifecycle and privacy-safe operational telemetry
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

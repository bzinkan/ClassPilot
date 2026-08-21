# ClassPilot - Chrome Extension

A privacy-aware Chrome Extension (Manifest V3) for classroom monitoring on managed Chromebooks.

## Features

- **Automatic Tab & URL Monitoring**: Automatically tracks and shares student browsing activity
- **Transparent Disclosure**: Clearly displays to students what's being monitored
- **Automatic Heartbeats**: Sends active tab title and URL every 10 seconds
- **Immediate Tab Updates**: Notifies server when student changes tabs
- **Periodic Screen Thumbnails**: Captures bounded active-tab screenshots for the teacher dashboard while tracking is active
- **Visible Indicators**: Shows in-page and popup indicators when school-managed monitoring is active
- **School Policy Compliance**: Designed for managed Chromebooks with district monitoring policies

## Installation for Testing

### Load Unpacked Extension (Development)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" in the top right
3. Click "Load unpacked"
4. Select the `extension` folder
5. The extension should now appear in your extensions list

### First Time Setup

1. On a managed single-user Chromebook, the extension attempts registration
   from the signed-in Google Workspace profile and the school's configured
   domain/enrollment policy.
2. On a shared Chromebook, click the extension icon and use the school-enabled
   sign-in flow (for example grade + name + PIN, email, or student ID).
3. Confirm the popup shows the correct student and school-server connection.
   Class assignment is resolved by SchoolPilot; students never enter a class ID.

### Durable kiosk device identity (2.6.9)

On managed (enrolled) Chromebooks the extension resolves the device's
directory id via `chrome.enterprise.deviceAttributes`, hashes it into an
opaque UUID, and appends it as `device=` on the PassPilot kiosk launch URL.
The kiosk page adopts it as the device's identity, so PassPilot's
teacher-resume memory survives the per-profile storage wipes that occur on
shared devices when the lid closes or a session ends. The raw directory id
never leaves the extension; unmanaged installs are unaffected (the
enterprise API is undefined there). Requires the `enterprise.deviceAttributes`
permission (no user-facing prompt; the API only functions on policy-installed
extensions).

### PassPilot kiosk purity + sign-out finality (2.6.8)

On `/passpilot/kiosk` pages the student FAB suppression is now a one-way
ratchet (a mismatched learned kiosk origin can no longer rebuild the full
FAB over a live kiosk), the auth gate never paints over a kiosk — including
the managed-policy revalidation states, which carry no kiosk origin — and
classroom broadcasts (attention mode, timers, polls, teacher messages) are
filtered out on kiosk pages. The "Monitored by school" disclosure indicator
stays visible.

Signing out is now final: a student who signs out (or is signed out
server-side) is never silently re-registered from the Chrome profile on a
later service-worker wake. The auto-registration pause is raised by every
deliberate or server-forced sign-out and is monotonic across repeated
clears. A different Google account signing into ChromeOS still registers
normally, and worker-restart continuity for an active session is unchanged.

### Fast shared-Chromebook sign-in gate (2.6.7)

On the first eligible HTTP(S) page, ClassPilot installs its interaction lock at
`document_start` and restores local authentication before starting classroom,
monitoring, and network initialization. Students who still need to sign in see
**Connecting to ClassPilot…** immediately while the live school configuration
loads. Cached configuration can shape this disabled loading screen, but it can
never authenticate a student or enable submission while offline.

The extension cannot run on the ChromeOS account sign-in screen, New Tab, or
other `chrome://` pages, and it never opens a page automatically. Schools that
want the gate immediately after Chrome opens should configure a normal managed
HTTPS startup page. `fastAuthGateEnabled` defaults to `true`; setting it to
`false` in managed extension policy temporarily restores the 2.6.5 startup
behavior as an emergency rollback while retaining all authentication checks.

The automated Chromium startup suite exercises managed-policy binding removal,
changed authority, read failures, and the kill switch through the extension's
worker contract. Playwright cannot populate enterprise `chrome.storage.managed`
policy, so release validation must also repeat policy-change and kill-switch
checks on a Google Admin-managed Chromebook before organizational-unit rollout.

## Chrome Web Store and Google Admin Deployment

### Create the Versioned Web Store ZIP

1. Confirm the live Chrome Web Store version and bump `extension/manifest.json`
   to the next version. The manifest is the release source of truth.
2. From the repository root in Git Bash, run:
   ```bash
   ./extension/package-extension.sh
   ```
3. Inspect the versioned `dist/ClassPilot-vX.Y.Z.zip`. It must contain
   root-level `manifest.json` and `managed_schema.json`, and the embedded
   manifest version must match the file name.

For the currently prepared release, the upload artifact is
`dist/ClassPilot-v2.6.9.zip`. `dist/classpilot-extension.zip` is only the
compatibility copy produced by the same script.

### Publish Through Chrome Web Store

1. Open the Chrome Web Store Developer Dashboard for listing
   `iggbfegfcjkfieoemeolfmfnapepalca`.
2. Upload only the reviewed versioned ZIP from `dist/`.
3. Complete the privacy/compliance review in `COMPLIANCE.md`, submit the update,
   and wait for Chrome Web Store review/publication.
4. Verify the published listing version before staging managed-device rollout.

### Force-Install the Published Listing

1. Log in to Google Admin Console (admin.google.com)
2. Navigate to **Devices** → **Chrome** → **Apps & Extensions**
3. Click **Chrome apps & extensions**
4. Select the organizational unit (e.g., "Students" or specific classes)
5. Click the **+** (Add) button
6. Choose **Add from Chrome Web Store** and select the ClassPilot listing above
7. Configure installation settings:
   - Installation: **Force install**
   - Permission: **Allow**

### Configure Extension Policy

After SchoolPilot admin enables **Shared Chromebook Sign-In**, copy the managed
policy JSON shown in ClassPilot Settings. It should look like this:

```json
{
  "serverUrl": { "Value": "https://school-pilot.net" },
  "schoolSlug": { "Value": "your-school-slug" },
  "enrollmentKey": { "Value": "your-shared-chromebook-setup-key" },
  "fastAuthGateEnabled": { "Value": true }
}
```

`schoolId` may be used instead of `schoolSlug` if needed. This is a one-time
school-level policy for the student Chromebook organizational unit. Do not add
grade, class, or Chromebook-specific fields. When Name + PIN login is enabled,
the student chooses their grade during sign-in, then selects their name and
enters their 4-digit ClassPilot PIN.

In Google Admin Console:
1. Find the force-installed ClassPilot listing
2. Click **Configure**
3. Find **Policy for extensions**
4. Paste the policy JSON
5. Save changes

If **Policy for extensions** does not appear, confirm the published extension
version includes `managed_schema.json` and the manifest `storage.managed_schema`
entry. Google Admin only exposes managed policy configuration for extensions
that declare a managed storage schema.

The extension will now be force-installed on all Chromebooks in the selected organizational unit.

## Configuration

The extension resolves the server URL in this order:

1. **Managed policy** (`chrome.storage.managed` → `serverUrl`)
2. **Saved overrides** (`chrome.storage.sync` or `chrome.storage.local`)
3. **Injected build-time value** (`globalThis.CLASSPILOT_SERVER_URL` from `config.js`)
4. **Default** `https://school-pilot.net`

For managed deployments, the Admin Console policy is the recommended source of truth. For custom builds, you can inject a URL in `extension/config.js` (copy from `config.example.js`).

Sentry configuration (and optional server URL injection) lives in `extension/config.js`, which is ignored by git. If the file was previously tracked, remove it from the index with:

```bash
git rm --cached extension/config.js
```

## Privacy & Transparency

### What's Monitored Automatically
- Active tab title
- Active tab URL
- Timestamps of activity
- Website favicon URL
- Heartbeat, connection, and device health state
- Periodic JPEG screenshot thumbnails of the active visible HTTP/HTTPS tab while tracking is active

### What's NOT Monitored
- Keystrokes or typed content
- Microphone audio or camera video
- Passwords
- Incognito/private windows
- Personal browsing from unmanaged profiles

### Automatic Monitoring
- **Tab titles and URLs are collected automatically** - No student action required
- Heartbeat sends data every 10 seconds
- Screen thumbnails are captured about every 30 seconds while tracking is active
- Teacher sees current tab and URL history in real-time
- Complies with school district monitoring policies for managed Chromebooks

### Live Screen Viewing
- Teachers may request live viewing during active class sessions
- Managed ChromeOS devices can allow silent tab capture through school Chrome policy
- On unmanaged devices, Chrome may show a picker instead
- Live streams are not recorded by the extension

### Transparency & Disclosure
The extension popup clearly displays:
- Banner stating "Monitoring Active"
- A school-managed monitoring disclosure
- Current connection status
- In-page FAB indicator stating "Monitored by school"

### Events Logged
The extension keeps a bounded retry outbox for authorized teaching-session or
supervision-context events. It sends only these typed events:

- `tab_changed` and `navigation_changed`
- `navigation_blocked`, including the policy source
- `monitoring_state_changed`
- `restriction_state_applied`, `restriction_state_failed`, and
  `restriction_state_cleared`

Navigation metadata is limited to the normalized domain, sanitized path, and a
bounded title. Credentials, query strings, fragments, keystrokes, clipboard or
form content, DOM content, screenshots, and arbitrary metadata are not stored
in the event outbox.

### Connectivity and command delivery

The toolbar badge and popup report heartbeat health without trying to infer why
the network path failed:

- Green `Connected` after a successful school-server heartbeat
- Amber `Reconnecting` after a retryable network or server failure
- Red `School server unreachable` when no heartbeat has succeeded for 60 seconds

Authentication and rate-limit states remain separate. The extension never
labels a connectivity gap as Wi-Fi disablement, tampering, cheating, or AI use.
On recovery it drains the identity-bound monitoring-event outbox and requests
the authoritative classroom restriction snapshot.

One-shot teacher actions honor the server-provided `transient_action` deadline
and acknowledge `expired` without execution once that deadline passes.
Persistent classroom controls continue to reconcile from their full stored
snapshot. Screenshot image bodies are never queued or written to local storage;
only bounded attempt, success, and error diagnostic timestamps/codes survive a
worker restart.

See `COMPLIANCE.md` for Chrome Web Store and school privacy review notes.

## Development

### File Structure
```
extension/
├── manifest.json          # Extension manifest (MV3)
├── managed_schema.json    # Google Admin managed policy schema
├── service-worker.js      # Background service worker
├── popup.html            # Extension popup UI
├── popup.js              # Popup logic
├── content.js            # Content script (runs on pages)
├── icons/                # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md             # This file
```

### Testing Locally

1. Copy `extension/config.example.js` to the ignored
   `extension/config.js` and set `globalThis.CLASSPILOT_SERVER_URL` to the local
   or test server. Never edit the production default in `service-worker.js`.
2. Load the extension as unpacked (see above).
3. Open the extension popup and complete the applicable managed-profile or
   shared-Chromebook sign-in flow.
4. Check the service-worker/offscreen consoles for heartbeat and WebSocket
   state, then verify the exact student appears in the teacher dashboard.
5. Before release, run `npm run check`, `npm test`,
   `npm run test:extension:chrome`, and `npm run build` from the repository root.

### Badge States
- 🟢 Green dot (●) - Connected and sending heartbeats
- 🔴 Red circle (◉) - Screen sharing active
- ❗ Red exclamation (!) - Connection error

## Troubleshooting

### Extension Not Sending Heartbeats
- Check browser console for errors
- Verify server URL is correct
- Ensure student completed setup in popup
- Check that cookies are enabled

### Screen Sharing Not Working
- Verify popup has user gesture (must click button)
- Check browser console for WebRTC errors
- Ensure Chrome has screen capture permissions
- Verify WebSocket connection is established

### WebSocket Connection Issues
- Check that server is running
- Verify WebSocket endpoint is `/ws`
- Ensure HTTPS/WSS protocol matches server
- Check for firewall or network restrictions

## License

This extension is designed for educational use in managed Chromebook environments. Ensure compliance with FERPA, COPPA, and local privacy regulations.

## Support

For issues or questions:
1. Check browser console logs
2. Verify server is running and accessible
3. Review Google Admin Console deployment settings
4. Check this README for troubleshooting steps

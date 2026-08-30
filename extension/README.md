# ClassPilot - Chrome Extension

A privacy-aware Chrome Extension (Manifest V3) for classroom monitoring on managed Chromebooks.

## Features

- **Automatic Tab & URL Monitoring**: Automatically tracks and shares student browsing activity
- **Transparent Disclosure**: Clearly displays to students what's being monitored
- **Automatic Heartbeats**: Sends active tab title and URL every 10 seconds
- **Immediate Tab Updates**: Notifies server when student changes tabs
- **Tracking-Window Screen Thumbnails**: Captures bounded active-tab screenshots about every 30 seconds while school-managed monitoring is active in an authorized tracking window, independent of teacher dashboard tab visibility, plus an exact-bound safety capture when requested
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

### Recoverable shared-device student sessions (2.7.3)

Manual student credentials and exact student-bound runtime state now live only
in Chrome's browser-session storage. A one-use server recovery capability is
kept separately without the student's name, bearer token, or device/session
identifiers. After Chrome restarts or the extension updates, the old exact
session is released in the background and the student signs in with their PIN
again; when that release is temporarily offline, the same Chromebook can still
offer the exact student as reclaimable. Ordinary tab closure and MV3 worker
suspension continue to preserve the active browser session.

Release retries use bounded alarms, and delayed cleanup from an older login
cannot end or erase a replacement session. Login-roster refreshes are
coalesced and short-lived in memory, with explicit refresh support and no
persisted roster names.

Starting in 2.7.8, a deliberate sign-out from a recovery-capable manual shared
session—and the extension-update boundary for that session—waits for one
bounded, exact bearer-bound server cleanup before the login roster opens. If
that cleanup cannot be confirmed, the same Chromebook retains its exact
PIN-protected Resume capability instead of hiding the student until the
five-minute abandoned-session lease expires.

### Reliable observation policy reconciliation (2.7.2)

Heartbeat and WebSocket protocol responses now order screenshot authority
independently. A policy-less WebSocket authentication frame cannot retire an
older in-flight heartbeat lease. ClassPilot retains only an unexpired lease for
the exact authenticated school, student, session, device, and server scope;
missing policy on a cold or changed binding, an expired lease, an explicit
denial, or malformed authority remains fail-private.

When SchoolPilot requests a capability heartbeat after a screenshot upload,
the extension coalesces one near-immediate heartbeat without changing its
normal 10-second cadence. A transient screenshot-store outage keeps only the
otherwise valid lease and recovers through the existing bounded retry and
30-second capture cadence.

### Private kiosk continuity tickets (2.7.1)

On managed (enrolled) Chromebooks, an explicit kiosk launch first makes a
non-sensitive, enrollment-key-authenticated capability preflight. Only when
SchoolPilot accepts `scopedAuthorityChecksV1` and `kioskLaunchTicketV2` may the
extension read the device's Chrome directory id through
`chrome.enterprise.deviceAttributes` and send it to that exact SchoolPilot
origin. SchoolPilot immediately converts it to a school-scoped opaque mapping
without storing or logging the raw value, then returns a random, one-use ticket
that expires after 10 minutes. The ticket is placed in the URL fragment as
`#launchTicket=...`. The raw directory id never appears in a URL, extension
storage, or logs, and the kiosk continuity mapping remains server-side. If
ticket creation fails, the kiosk still opens without continuity. Unmanaged
installs are unaffected (the enterprise API is undefined there).

This requires the `enterprise.deviceAttributes` permission. It produces no
user-facing prompt and only functions for policy-installed extensions.

### Exact-bound monitoring and delivery (2.7.1)

Every authenticated heartbeat, screenshot, command acknowledgement, chat
retry, and Live View negotiation is fenced to an immutable school, student,
student-session, device, server-origin, and authentication context. Work that
finishes after an identity transition is discarded. Teacher commands validate
that binding before expiry checks, deduplication, acknowledgements, or side
effects, and tab-close safety actions require the exact opaque tab reference
and snapshot revision.

Student chat messages use a client-generated id and a bounded, exact-binding
retry outbox. A message is removed only after SchoolPilot echoes both the
client and server ids. It is never replayed for a different student, session,
school, device, or server.

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
   manifest version must match the file name. Packaging compares every ZIP
   file byte-for-byte with the source allowlist and writes a `.sha256` record.
4. Run `npm run test:extension:package` to repeat the Chrome integration suites
   against the unpacked versioned ZIP.

For the currently prepared release, the upload artifact is
`dist/ClassPilot-v2.7.8.zip`. `dist/classpilot-extension.zip` is only the
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
- Tracking-window JPEG screenshot thumbnails of the active visible HTTP/HTTPS tab; SchoolPilot retains only teaching-session-bound thumbnails and discards student-session/gap pixels on receipt
- An exact-bound screenshot immediately before a requested safety tab closure, when capture succeeds within the bounded window

### What's NOT Monitored
- Keystrokes or typed content
- Microphone audio or camera video
- Passwords
- Incognito/private windows
- Personal browsing from unmanaged profiles

### Automatic Monitoring
- **Tab titles and URLs are collected automatically** - No student action required
- Heartbeat sends data every 10 seconds
- In negotiated tracking-window mode, active-tab thumbnails are captured about every 30 seconds while school-managed monitoring is active inside the server-authorized tracking window, whether or not a teacher currently has the dashboard tab visible
- Every upload is bound to the exact current student or teaching session and control revision. SchoolPilot discards gap/student-session pixels on receipt and retains only class-bound thumbnails
- Capture stops when school tracking policy is hard-off, after sign-out/session expiry or an authentication/explicit license denial, or when the short-lived tracking-window lease expires or is revoked
- The older observation-lease capability remains available for mixed-version rollout; a server-selected legacy screenshot mode remains an explicit fallback
- Teacher sees current tab and URL history in real-time
- Complies with school district monitoring policies for managed Chromebooks

Monitored time, domain time, and off-task duration are derived from the
10-second heartbeat stream. Screenshots are not used for those calculations.

### Live Screen Viewing
- Teachers may request live viewing during active class sessions
- Managed ChromeOS devices can allow silent tab capture through school Chrome policy
- On unmanaged devices, Chrome may show a picker instead
- Live streams are not recorded by the extension or SchoolPilot servers; the
  authorized teacher dashboard can explicitly save a local recording or still
  image that is controlled by the school
- Short-lived, server-authorized ICE configuration may include SchoolPilot TURN
  relays so a session can connect when direct UDP is unavailable

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

Student-to-teacher chat uses a bounded local retry outbox (maximum 40 messages,
128 KiB, and 30 minutes). An expiry alarm physically removes aged message
bodies from local storage, including terminal failed entries. The command-ACK
outbox is likewise physically compacted at its 24-hour safety bound.
Authentication, binding, command, and outbox storage failures stop the affected
operation; privacy-safe diagnostics remain best effort.

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
   `npm run test:extension:chrome`, `npm run build`, package the versioned ZIP,
   and run `npm run test:extension:package` from the repository root.

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

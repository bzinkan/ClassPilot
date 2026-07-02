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

1. Click the extension icon in your Chrome toolbar
2. Enter your name and class ID
3. Click "Connect to Classroom"
4. The extension will start sending heartbeats to the server

## Google Admin Deployment

### Create ZIP for Force-Install

1. From the repository root, run:
   ```bash
   ./extension/package-extension.sh
   ```
2. Upload the versioned zip from `dist/`.

### Upload to Google Admin Console

1. Log in to Google Admin Console (admin.google.com)
2. Navigate to **Devices** → **Chrome** → **Apps & Extensions**
3. Click **Chrome apps & extensions**
4. Select the organizational unit (e.g., "Students" or specific classes)
5. Click the **+** (Add) button
6. Choose **Upload private app**
7. Upload the versioned `ClassPilot-vX.Y.Z.zip` file from `dist/`
8. Configure installation settings:
   - Installation: **Force install**
   - Permission: **Allow**

### Configure Extension Policy

After SchoolPilot admin enables **Shared Chromebook Sign-In**, copy the managed
policy JSON shown in ClassPilot Settings. It should look like this:

```json
{
  "serverUrl": { "Value": "https://school-pilot.net" },
  "schoolSlug": { "Value": "your-school-slug" },
  "enrollmentKey": { "Value": "your-shared-chromebook-setup-key" }
}
```

`schoolId` may be used instead of `schoolSlug` if needed. This is a one-time
school-level policy for the student Chromebook organizational unit. Do not add
grade, class, or Chromebook-specific fields. When Name + PIN login is enabled,
the student chooses their grade during sign-in, then selects their name and
enters their 4-digit ClassPilot PIN.

In Google Admin Console:
1. Find the uploaded extension
2. Click **Configure**
3. Find **Policy for extensions**
4. Paste the policy JSON
5. Save changes

If **Policy for extensions** does not appear, confirm the uploaded extension
version includes `managed_schema.json` and the manifest `storage.managed_schema`
entry. Google Admin only exposes managed policy configuration for extensions
that declare a managed storage schema.

The extension will now be force-installed on all Chromebooks in the selected organizational unit.

## Configuration

The extension resolves the server URL in this order:

1. **Managed policy** (`chrome.storage.managed` → `serverUrl`)
2. **Saved overrides** (`chrome.storage.sync` or `chrome.storage.local`)
3. **Injected build-time value** (`globalThis.CLASSPILOT_SERVER_URL` from `config.js`)
4. **Default** `https://classpilot.replit.app`

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
The extension logs the following events to the server:
- `consent_granted` - When student starts screen sharing
- `consent_revoked` - When student stops screen sharing
- `tab_change` - When student switches tabs

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

1. Update `serverUrl` in `service-worker.js` to point to your local or Replit server
2. Load the extension as unpacked (see above)
3. Open the extension popup and complete setup
4. Check the browser console for heartbeat logs
5. Verify data appears in the teacher dashboard

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

# Classroom Screen Awareness - Chrome Extension

A privacy-aware Chrome Extension (Manifest V3) for classroom monitoring on managed Chromebooks.

## Features

- **Automatic Screen Monitoring**: Automatically shares student screens with teacher dashboard
- **Transparent Disclosure**: Clearly displays to students what's being monitored
- **Automatic Heartbeats**: Sends active tab title and URL every 10 seconds
- **Immediate Tab Updates**: Notifies server when student changes tabs
- **Automatic Screen Sharing**: Screen capture starts automatically on extension load
- **Visible Indicators**: Shows badge icon indicating monitoring/sharing status
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

1. Navigate to the extension directory
2. Create a ZIP file containing all extension files:
   ```bash
   zip -r classroom-screen-awareness.zip manifest.json service-worker.js popup.html popup.js content.js icons/
   ```

### Upload to Google Admin Console

1. Log in to Google Admin Console (admin.google.com)
2. Navigate to **Devices** → **Chrome** → **Apps & Extensions**
3. Click **Chrome apps & extensions**
4. Select the organizational unit (e.g., "Students" or specific classes)
5. Click the **+** (Add) button
6. Choose **Upload private app**
7. Upload the `classroom-screen-awareness.zip` file
8. Configure installation settings:
   - Installation: **Force install**
   - Permission: **Allow**

### Configure Extension Policy

Create a policy JSON file with the server URL:

```json
{
  "serverUrl": "https://your-replit-app-url.replit.dev",
  "schoolId": "your-school-id"
}
```

In Google Admin Console:
1. Find the uploaded extension
2. Click **Configure**
3. Paste the policy JSON
4. Save changes

### Enable Automatic Screen Capture (Enterprise Policy)

For **truly automatic** screen sharing without user dialogs, configure the following Chrome Enterprise Policy in Google Admin Console:

1. Navigate to **Devices** → **Chrome** → **Settings** → **Users & browsers**
2. Find the **Screen capture** settings
3. Configure the following policies:

**Option A: Allow Automatic Screen Capture (Recommended)**
- Set **ScreenCaptureAllowed** to **Allow**
- Add your extension ID to **ScreenCaptureAllowedByOrigins**

**Option B: Enterprise Screen Capture API**
- This requires Chrome Enterprise enrollment
- Screen capture will work without user dialogs when force-installed

**Important Notes:**
- Without enterprise policies, students will see a one-time screen picker dialog
- Once selected, screen sharing continues automatically
- Enterprise Chrome policies allow true silent screen capture on managed devices
- Consult your IT administrator for enterprise policy configuration

The extension will now be force-installed on all Chromebooks in the selected organizational unit with automatic screen sharing enabled.

## Configuration

The extension connects to the server specified in `service-worker.js`:

```javascript
let CONFIG = {
  serverUrl: 'https://your-server-url.replit.dev',
  heartbeatInterval: 10000, // 10 seconds
  schoolId: 'default-school',
};
```

Update the `serverUrl` to point to your deployed Replit application before deployment.

## Privacy & Transparency

### What's Monitored
- ✓ **Full screen display** - Entire screen visible to teacher in real-time
- ✓ Active tab title
- ✓ Active tab URL
- ✓ Timestamps of activity
- ✓ Website favicon (icon)

### What's NOT Monitored
- ✗ Keystrokes typed (unless visible on screen during screen share)
- ✗ Microphone or camera audio/video
- ✗ Private messages (unless visible on screen during screen share)
- ✗ Incognito/private windows
- ✗ Content not visible on screen

### Automatic Screen Sharing
- **Starts automatically** when extension is active (no student action required)
- Shows visible "Sharing Active" indicator with pulsing red dot
- Teacher can view student screen in real-time through dashboard
- Logs consent granted/revoked events for audit
- Complies with school district monitoring policies

### Transparency & Disclosure
The extension popup clearly displays:
- Banner stating "Automatic Monitoring Active"
- Current connection status
- Screen sharing status indicator
- Privacy information accessible via "What's being collected?" link

### Events Logged
The extension logs the following events to the server:
- `consent_granted` - When automatic screen sharing starts
- `consent_revoked` - When screen sharing ends
- `tab_change` - When student switches tabs

## Development

### File Structure
```
extension/
├── manifest.json          # Extension manifest (MV3)
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

### Automatic Screen Sharing Not Working
- **First-time setup**: Students may see a one-time screen picker dialog (normal behavior)
- **Enterprise deployment**: Configure Chrome Enterprise policies for silent screen capture
- Check browser console for WebRTC errors
- Ensure Chrome has screen capture permissions (`desktopCapture` permission in manifest)
- Verify WebSocket connection is established
- Check that extension is force-installed via Google Admin (not manually loaded)
- Verify enterprise policies allow automatic screen capture

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

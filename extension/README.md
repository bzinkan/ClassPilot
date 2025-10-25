# Classroom Screen Awareness - Chrome Extension

A privacy-aware Chrome Extension (Manifest V3) for classroom monitoring on managed Chromebooks.

## Features

- **Transparent Monitoring**: Clearly displays to students what's being monitored
- **Automatic Heartbeats**: Sends active tab title and URL every 10 seconds
- **Immediate Tab Updates**: Notifies server when student changes tabs
- **Opt-In Screen Sharing**: Students must explicitly click to share their screen
- **Visible Indicators**: Shows badge icon indicating monitoring/sharing status
- **Privacy First**: No keystrokes, microphone, or camera access

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

The extension will now be force-installed on all Chromebooks in the selected organizational unit.

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
- ✓ Active tab title
- ✓ Active tab URL
- ✓ Timestamps of activity
- ✓ Website favicon (icon)

### What's NOT Monitored
- ✗ Keystrokes or typed content
- ✗ Microphone or camera
- ✗ Private messages
- ✗ Incognito/private windows
- ✗ Screenshots (unless screen sharing is active)

### Screen Sharing
- Requires explicit student click on "Share My Screen" button
- Shows visible "Sharing Active" indicator with pulsing red dot
- Can be stopped anytime with "Stop Sharing" button
- Logs consent granted/revoked events for audit

### Consent Events
The extension logs the following events to the server:
- `consent_granted` - When student starts screen sharing
- `consent_revoked` - When student stops screen sharing
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

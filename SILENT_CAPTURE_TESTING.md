# Silent Tab Capture - Testing Guide

> **Correction (2026-09-01).** Earlier versions of this document claimed that
> ClassPilot could capture a student tab silently on managed Chromebooks. That
> claim was wrong and has been removed. The extension requests a tab stream via
> `chrome.tabCapture.getMediaStreamId` (`extension/service-worker.js`). Chrome
> only grants tab capture to an extension that holds an `activeTab` grant from a
> user gesture on the extension's action, and ClassPilot's action is
> `default_state: "disabled"` with no popup (`extension/manifest.json`), so that
> grant never exists. On ChromeOS the student ALWAYS sees Chrome's tab/screen
> picker. The `TabCaptureAllowedByOrigins`, `ScreenCaptureAllowedByOrigins`, and
> `SameOriginTabCaptureAllowedByOrigins` Google Admin policies govern web origins
> calling `getDisplayMedia()`, not this extension, so they do not enable silent
> capture. Live View is currently disabled in the teacher UI
> (`LIVE_VIEW_UI_ENABLED=false`). Any remaining "silent capture succeeded"
> expectations further down are historical and do not occur.

> **Historical test notes.** Hostnames and prototype flows below are not
> production configuration. Validate ClassPilot 2.7.1 Live View only through the
> exact-session direct and TURN/TURNS gates in the SchoolPilot repository's
> `docs/CLASSPILOT_2_7_1_RELEASE.md` and current managed test OU.

## What Was Implemented

The Chrome Extension uses a two-step capture attempt:

1. **First Attempt**: `chrome.tabCapture.getMediaStreamId()` - Succeeds only when the
   extension holds an `activeTab` grant from a user gesture on its action. ClassPilot's
   action is disabled with no popup, so this attempt fails on every device.
2. **Fallback**: `navigator.mediaDevices.getDisplayMedia()` - Shows Chrome's tab/screen
   picker to the student. This is the path Live View actually uses.

## Expected Behavior

### On Managed Chromebooks (with or without Google Admin capture policies)
```
Teacher clicks "Go Live" → tabCapture attempt fails (no activeTab grant) → Picker appears → Student selects → Video streams
```

### On Non-Managed Devices
```
Teacher clicks "Go Live" → tabCapture attempt fails (no activeTab grant) → Picker appears → Student selects → Video streams
```

The two flows are identical. There is no silent capture path.

## Testing Steps

### 1. Reload the Extension
1. Open `chrome://extensions` in the student Chrome profile
2. Find "ClassPilot" extension
3. Click the **reload/refresh icon** ⟳
4. ✅ Extension reloaded with new capture code

### 2. Test the Capture Flow
1. **Teacher Dashboard** (Chrome Profile 1):
   - Login at https://classpilot.replit.app
   - Navigate to Dashboard
   - Find a student tile that shows "Online"
   
2. **Student Browser** (Chrome Profile 2):
   - Make sure extension is loaded and configured
   - Open a website (e.g., google.com, youtube.com)
   - Check that heartbeats are working (tile shows online in teacher dashboard)

3. **Initiate Screen Share**:
   - In teacher dashboard, click "Go Live" (eye icon) on student tile
   - **Watch the student browser for prompts**

### 3. Verify Console Logs

**Student Browser Console** (`F12` → Console tab):

Look for these logs in order:

```
[WebRTC] Teacher requested screen share
[Service Worker] Message from offscreen: START_SHARE
[Offscreen] Starting screen capture, mode: auto
[Offscreen] Attempting silent tab capture...
```

**Expected on non-managed devices:**
```
[Offscreen] Silent tab capture failed: Extension has not been invoked...
[Offscreen] Tab capture not available, falling back to screen picker...
```
→ **Picker should appear**

**Expected on managed devices (with policy):**
```
[Offscreen] ✅ Silent tab capture succeeded!
[Offscreen] Got media stream from tab capture, creating peer connection
```
→ **No picker, silent capture works!**

### 4. Check WebRTC Connection

After selecting screen (or silent capture):

```
[Offscreen] Created and set local description (answer)
[WebRTC] Offer handled in offscreen document
[Offscreen] Connection state: connected
```

**Teacher Dashboard:**
- Video should appear in student tile
- Should show live tab content from student browser

## Console Log Reference

### Success Flow (Silent Capture)
```
1. [Service Worker] Offscreen document created
2. [Offscreen] Sending READY signal
3. [Service Worker] Offscreen document is ready
4. [WebRTC] Teacher requested screen share, mode: auto
5. [Offscreen] Attempting silent tab capture...
6. [Offscreen] ✅ Silent tab capture succeeded!
7. [Offscreen] Got media stream from tab capture, creating peer connection
8. [Offscreen] Tracks added to peer connection, ready for offer
9. [Offscreen] Handling signal: offer
10. [Offscreen] Set remote description (offer)
11. [Offscreen] Created and set local description (answer)
12. [Service Worker] Message from offscreen: ANSWER
13. [Offscreen] Connection state: connected
```

### Fallback Flow (Picker Shown)
```
1-4. (Same as above)
5. [Offscreen] Attempting silent tab capture...
6. [Offscreen] Silent tab capture failed: Extension has not been invoked for the current page. Chrome pages cannot be captured.
7. [Offscreen] Tab capture not available, falling back to screen picker...
8. (User sees picker and selects screen/window/tab)
9. [Offscreen] Got media stream from screen picker, creating peer connection
10-13. (Same as success flow)
```

### Error Scenarios

**No offscreen document:**
```
[Service Worker] Error creating offscreen document: ...
[WebRTC] Screen share request error: Failed to start screen share
```

**User cancels picker:**
```
[Offscreen] Screen capture error: NotAllowedError: Permission denied
[Service Worker] Message from offscreen: CAPTURE_ERROR
```

**Connection fails:**
```
[Offscreen] Connection state: failed
[Service Worker] Message from offscreen: CONNECTION_FAILED
```

## Debugging Tips

### Check Extension Permissions
1. Go to `chrome://extensions`
2. Click "Details" on ClassPilot
3. Verify these permissions are granted:
   - Tabs
   - Storage
   - Notifications
   - Tab capture
   - Offscreen

### Check WebRTC Connection
1. Open `chrome://webrtc-internals` in teacher browser
2. Look for active PeerConnection
3. Check ICE candidate exchange
4. Verify video track is active

### Check Service Worker
1. Go to `chrome://extensions`
2. Click "Service worker" link under ClassPilot
3. Check console for errors
4. Verify WebSocket connection is established

## Google Admin Policy Configuration

There is no Google Admin policy that makes ClassPilot's Live View silent.

The capture policies under **Google Admin Console → Devices → Chrome → Settings →
Users & browsers → [Student OU]** ("Screen capture allowed by URLs",
"Tab capture allowed by URLs", "Same-origin tab capture allowed by URLs", i.e.
`ScreenCaptureAllowedByOrigins`, `TabCaptureAllowedByOrigins`,
`SameOriginTabCaptureAllowedByOrigins`) apply to **web origins** that call
`navigator.mediaDevices.getDisplayMedia()`. They control which sites may capture
and how Chrome presents the picker to those sites. They do not apply to a Chrome
extension's `chrome.tabCapture` calls and they do not grant the extension the
`activeTab` permission that `tabCapture.getMediaStreamId` requires. Listing any
origin in them does not change what the student sees when a teacher starts Live
View.

What matters on a managed Chromebook:
1. Force-install the ClassPilot extension to the student OU.
2. Do not disable screen capture for the OU (`ScreenCaptureAllowed` must not be
   `false`), or Live View fails with `NotAllowedError` before any picker appears.
3. On the student Chromebook: `chrome://policy` → "Reload policies".
4. Test "Go Live" - the student sees Chrome's tab/screen picker and must accept
   it. The picker is expected behavior, not a misconfiguration.

## Common Issues

### Issue: Picker always shows (on managed devices)
**Cause**: Expected. Chrome only grants extension tab capture after an `activeTab`
grant from a user gesture on the extension's action, and ClassPilot's action is
disabled with no popup. No Google Admin policy changes this.  
**Fix**: None needed. The picker is the designed Live View flow on every device.

### Issue: "Extension has not been invoked"
**Cause**: `tabCapture` requires an `activeTab` grant from a user gesture on the
extension's action, which this extension never receives  
**Fix**: This is expected on every device, managed or not - the picker fallback is
the real capture path

### Issue: Video doesn't appear in teacher dashboard
**Cause**: WebRTC connection failed  
**Fix**: Check `chrome://webrtc-internals` for connection errors

### Issue: "Only a single offscreen document may be created"
**Cause**: Offscreen document already exists  
**Fix**: This should be fixed - if you see it, reload the extension

### Issue: "Receiving end does not exist"
**Cause**: Message sent before offscreen ready  
**Fix**: This should be fixed with OFFSCREEN_READY handshake - if you see it, report as bug

## Expected Test Results

✅ **Without Google Admin Policy (Current Testing)**:
- Silent capture fails
- Picker appears automatically
- Student selects screen/tab/window
- Video streams to teacher

✅ **With Google Admin Policy (Production)**:
- Silent capture succeeds
- No picker shown
- No student interaction
- Video streams instantly

## Next Steps After Testing

If testing confirms fallback works correctly:
1. Deploy to production
2. Configure Google Admin policies
3. Test on actual managed Chromebooks
4. Verify completely silent capture

---

**Testing Date**: November 1, 2025  
**Version**: 1.0.0 - Tab capture via Chrome picker (corrected 2026-09-01; no silent path)  
**Status**: Ready for testing

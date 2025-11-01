# Silent Tab Capture - Testing Guide

## What Was Implemented

The Chrome Extension now uses a **silent-first capture strategy**:

1. **First Attempt**: `chrome.tabCapture.capture()` - Silent, no student prompt
2. **Fallback**: `navigator.mediaDevices.getDisplayMedia()` - Shows picker if silent fails

## Expected Behavior

### On Managed Chromebooks (with Google Admin policy configured)
```
Teacher clicks "Go Live" → Silent tab capture → NO student prompt → Video streams
```

### On Non-Managed Devices (current testing environment)
```
Teacher clicks "Go Live" → Silent capture fails → Picker appears → Student selects → Video streams
```

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

To enable **truly silent capture** on managed Chromebooks, configure these policies:

**Google Admin Console → Devices → Chrome → Settings → Users & browsers → [Student OU]**

| Policy Setting | Value |
|---|---|
| Screen capture allowed by URLs | `https://classpilot.replit.app` |
| Tab capture allowed by URLs | `https://classpilot.replit.app` |
| Same-origin tab capture allowed by URLs | `https://classpilot.replit.app` |

After configuring:
1. Force-install ClassPilot extension to student OU
2. On student Chromebook: `chrome://policy` → "Reload policies"
3. Verify policies appear in the list
4. Test "Go Live" - should be **completely silent**

## Common Issues

### Issue: Picker always shows (on managed devices)
**Cause**: Google Admin policy not configured correctly  
**Fix**: Verify policy settings match exactly as shown above

### Issue: "Extension has not been invoked"
**Cause**: `tabCapture` requires user interaction or policy  
**Fix**: This is expected on non-managed devices - picker fallback works correctly

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
**Version**: 1.0.0 - Silent Tab Capture  
**Status**: Ready for testing

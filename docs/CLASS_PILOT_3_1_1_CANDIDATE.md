# ClassPilot 3.1.1 student popup contrast

The packaged popup meets the 4.5:1 normal-text contrast target for the
header, school name, detected email, Ask Question, Send and empty inbox.
Additional checks cover the Raise Hand gradient, disabled hand-raising and
messaging notices, and read and unread message timestamps.

The tested popup is the packaged `popup.html` page. Managed Chromebook students
ordinarily use the in-page ClassPilot control. The Chromium action has no
default toolbar popup on that platform.

## Everyday Chromebook classroom controls

An installed-extension browser fixture opens the in-page classroom control
on a synthetic lesson. The launcher exposes its name and expanded state.
Students can reach Message by Tab, enter the composer, and return to the
launcher with Escape or Close. Unavailable class tools stay hidden, and
keyboard focus is visible. The teacher and student chat bubbles, empty state,
header and send button use higher contrast. The composer fits narrow views.

## Reduce access for retired streaming

This candidate removes the required tabCapture and optional desktopCapture
permissions. The production service retired Live View and parked its TURN
infrastructure. A stale request cannot start a legacy stream or screen picker.
The remaining all-sites host grant and tabs.captureVisibleTab support the active
thumbnail feature and a separate selected-student detail preview when an
authorized classroom view is open. A short detail lease permits one still
image up to 1920 pixels per five seconds. The extension keeps those pixels
only in memory locally. The offscreen permission preserves classroom WebSocket and
preview timing. Google Admin kiosk identity and enterprise.deviceAttributes stay
unchanged. Existing historical lifecycle tests exercise simulated old privileges.

The offscreen creation call retains the inherited USER_MEDIA, DISPLAY_MEDIA and BLOBS reason labels. Active use is the classroom WebSocket and authorized preview timing. The service worker processes preview JPEG Blobs. The package blocks retired streaming requests before media acquisition.

## Verify and package

Use the prepared source and package commands in CLAUDE.md. Check the configured,
signed-in student view with an empty inbox. Use Tab to reach Raise Hand, the
message field, Ask Question and Send. Check text contrast at rest, hover and
keyboard focus. Check teacher-disabled messaging and an empty inbox after refresh.
Record the exact verified ZIP and SHA-256 separately from publication.

The Chrome Web Store listing and Google's public update service showed 3.1.0
on November 25, 2026. The candidate must be reviewed and tagged before Store
submission. In the authenticated Chrome Web Store Developer Dashboard, verify
the published version and any pending submission for item
`iggbfegfcjkfieoemeolfmfnapepalca` immediately before upload. A public
listing or a source tag cannot confirm whether another package is pending.

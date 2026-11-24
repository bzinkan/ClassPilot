# ClassPilot 3.1.0 class announcements

This Chromebook release keeps **Close** visible on shorter viewports when a
teacher uses **Class tools → Messages → Announce to class**. Students can
scroll the message body and close the announcement without leaving the tab.

The minimum supported browser remains Chrome 120. The release adds no Chrome
permissions, managed policy keys, or SchoolPilot API dependencies.

## Package and verification

Build `dist/ClassPilot-v3.1.0.zip` from the clean tagged revision using
`bash extension/package-extension.sh`. Preserve its `.sha256` record and run
`npm run test:extension:package` against the same ZIP. The teacher messaging
browser suite checks keyboard scrolling and click-to-close on a short viewport.

Verify the live version and any pending submissions in the authenticated Chrome
Web Store Developer Dashboard before uploading. Record Store publication and
managed-device adoption after verifying each one.

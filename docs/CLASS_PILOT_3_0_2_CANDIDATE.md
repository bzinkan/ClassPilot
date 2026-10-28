# ClassPilot 3.0.2 Focus notification release

This successor is based on the merged 3.0.1 source. The extension manifest,
package verifier, release test, and versioned ZIP use **3.0.2**. The npm app
package version is independent of the Chrome extension version.

## Student notification wording

- Applying the existing current-website restriction says **Focus Set**.
- An existing new-tab reminder for that restriction says **Focus Active**.
- A screen-only release says **Focus Stopped**. When a class Flight Path
  remains active, the message says so explicitly.
- A legacy full unlock retains **Screen Unlocked**. Release messages explain
  that other classroom or school browsing restrictions may still apply.

Messages refer to the website or resource selected by the teacher instead of
implying every page on a domain is available for a precise resource restriction.
Existing authoritative snapshots remain silent; this release adds no new
notification paths or notification timing changes.

`lock-screen`, `screenLock`, `unlock-screen { screenOnly: true }`, precise
resource scopes, Flight Paths, school policies, sign-in pass-through, and
legacy tab Focus cleanup retain their existing behavior and identifiers. The
extension keeps the existing tab Focus compatibility used for cleanup; the
SchoolPilot backend rejects new persistent tab Focus starts. Bring Forward
remains a one-time tab activation.

No permission, host permission, managed-policy key, capability, protocol
version, or collected data is added. The SchoolPilot API/web deployment is
separate and already uses the teacher-facing Focus name.

## Verification

Use Node 24 and the repository's standard gates:

```sh
npm ci
npm run check
npm test
npm run test:extension:chrome
npm run build
bash extension/package-extension.sh
npm run test:extension:package
```

The notification harness runs in both the Chrome behavior aggregate and the
unpacked-ZIP integration aggregate. It exercises production notification paths,
screen-only versus full unlock, independent restriction preservation, precise
resource reminders, silent snapshots, and legacy tab Focus compatibility.
The package verifier separately verifies every allowed ZIP file byte-for-byte
against the reviewed source, the root manifest version, and the archive name.
Its explicit exit status is authoritative even if the packaging shell prints
a success message after an earlier failure.

CI also runs the behavior and package tests on Chrome 120, 133, 152, and current
stable. Automated fixtures are synthetic; they do not establish managed-device
adoption or Chrome Web Store publication.

## Package and publication

Build from the reviewed source and verify the final merged source has the same
tree. Preserve older versioned artifacts. Copy the verified package and its
checksum without changing their bytes to the existing release folder:

- `C:\GitHub\ClassPilot\dist\ClassPilot-v3.0.2.zip`
- `C:\GitHub\ClassPilot\dist\ClassPilot-v3.0.2.zip.sha256`

Record the merged commit, tag, archive hash, tests, and submission/publication
state beside the archive. Immediately before uploading, confirm the current
Store version and pending submissions in the authenticated Developer Dashboard
for extension `iggbfegfcjkfieoemeolfmfnapepalca`. Earlier live-version observations
and cached public listings are historical evidence, not a pending-submission
check. A prepared ZIP or Git merge does not establish a Store upload, review,
publication, or managed-device upgrade. Store rollback requires a forward
version; do not reuse an uploaded version number or substitute another ZIP
under a recorded checksum.

# ClassPilot 3.0.4 class-transition recovery

The Chromebook successor is prepared as **3.0.4**. Its runtime repair is source
commit `4f202712fa6a2f16cf9db935482eb5cba751e361`, based on main
`be36eda024826c0c167523982992c6172234fcf0`. The manifest, release unit guard and
package verifier use 3.0.4 together; the root application and separately
versioned Windows packages remain independent.

## Scope

An in-flight classroom FAB transition could append an overlay clear after a
heartbeat-triggered storage cleanup had published its own barrier. That formed
a circular wait and prevented heartbeat and authentication queues from
progressing. Cleanup now drains the existing writer queues to a stable frontier
before synchronously publishing its own completion barrier. Children can
finish, later writers remain ordered behind physical cleanup, and exact
student/session/school/authentication-generation checks remain enforced.

The actual-worker regression covers repeated classroom transitions, heartbeat
adoption, nested overlay writers, concurrent cleanup, retired callbacks,
physical-purge ordering and subsequent authentication/heartbeat progress.
The separate auth-startup cohort fixture now holds replies until all three
requests enter the disposable worker; production cold/warm behavior and all
assertions are retained.
See [the repair evidence](CLASS_PILOT_STORAGE_HANDOFF_RECOVERY.md).

This version carries the existing 3.0.3 behavior forward. It adds no permission,
managed-policy key, wire protocol, capability or collected data. SchoolPilot's
server/UI chat-readiness repair is released from the SchoolPilot repository;
an API/web deployment does not distribute this extension.

## Validation and final artifact

Use Node 24 or newer and run:

- `npm run check`, `npm test`, `npm run build`.
- `npm run test:extension:storage-handoff` and `npm run test:extension:chrome`.
- `bash extension/package-extension.sh`, then `npm run test:extension:package`.

The runtime repair already passed the full source and unpacked behavior gates,
20 historical expected-red cases, 209 unit tests, and separate Windows
development parity checks before this version-only preparation. The new handoff
case passed in desktop browsers 151 and 156. Bind the final 3.0.4 validation to
its final source and ZIP rather than treating those prior receipts as proof of
this package's identity. Automated desktop browsers do not establish managed
ChromeOS adoption or physical acceptance.

After review and merge, build the final package only from the clean, tagged
release source. Record the exact source SHA/tag, versioned ZIP SHA-256 and
verification results beside the artifact. The versioned outputs are
`dist/ClassPilot-v3.0.4.zip` and `dist/ClassPilot-v3.0.4.zip.sha256`. The verifier
must confirm every allowed file byte-for-byte and pass the unpacked behavior
suite. Preserve all older versioned archives and their recorded hashes; never
replace a reviewed or uploaded archive with different bytes.

Deliver the verified bytes to `C:\GitHub\ClassPilot\dist\ClassPilot-v3.0.4.zip`
with its matching `.sha256` record. Verify that destination is absent or already
identical before copying; do not switch or alter the primary checkout's source.

## Store boundary

The operator selected 3.0.4 for preparation. This record makes no claim about
the live Store version or pending submissions. No Store upload or publication
is part of preparation. Immediately before uploading, recheck the live version
and pending submissions in the authenticated Developer Dashboard for extension
`iggbfegfcjkfieoemeolfmfnapepalca`. Store publication and installed managed-device
adoption are separate evidence. Keep the exact verified ZIP unchanged.

# ClassPilot 3.0.5 telemetry and screenshot efficiency

The Chromebook candidate is **3.0.5**, with Chrome **120** as its minimum.
It retains the reviewed 3.0.4 class-transition recovery and adds the efficiency
work implemented through runtime source
`77c88465e337b5fb922658f714ba76674365b943`, based on main
`c0a21a42654d2a0f8b4778f33c34547fdba668f5`. The 3.0.5 preparation changes only
the coordinated version guards and release documentation. The root application
and separately versioned Windows packages remain independent.

## Scope

- Routine heartbeat and screenshot operations can use the authenticated
  WebSocket after negotiating `deviceTelemetryTransportV1`; canonical server
  receipts and stable operation IDs preserve HTTP recovery and idempotency.
- A genuine fresh capture can reuse an acknowledged exact-scope image through
  `scopedScreenshotReferencesV1`. Metadata and capture timestamps remain fresh.
- `scopedScreenshotDeltasV1` can send a bounded lossless patch against one
  acknowledged image. The canonical codec reconstructs identical JPEG bytes;
  an 8 ms encoding budget, minimum savings and logical full-frame bounds fall
  back to the original full image. A missing base retries that same capture.

No permission, managed-policy key, image-quality reduction, capture-cadence
change, history reduction or global pixel cache is introduced. Authentication,
school/student/session/context/revision fences are rechecked after asynchronous
work. Pixels stay in bounded in-memory capture state and are not persisted by
the extension. Safety evidence retains its existing full-image path.

SchoolPilot owns rollout, authorization, server storage and teacher decoding.
The child capabilities require their scoped-authority, transport, reference
and tracking-lease parents. Windows continues to filter the unsupported
Chromebook transport/reference/delta capabilities. Advertising a capability
does not enable it for a school, distribute this ZIP or establish device adoption.

## Validation and artifact identity

The runtime source above passed Node 24 type checking, 209 unit tests, build,
48 focused transport/reference/delta tests, real packaged Chrome captures and
exact recovery, Windows channel/package/Chrome/Edge parity, the complete source
Chrome behavior/recovery gate and 20 historical expected-red cases. One initial
ACK diagnostic fixture captured an empty synthetic retry; unchanged ACK code
passed four isolated reruns and the complete second source gate. Do not omit
that first result when preserving the validation receipt.

For the final 3.0.5 source, run Node 24 `npm run check`, `npm test`,
`npm run build`, the focused telemetry tests, and the complete
`npm run test:extension:package` against the generated ZIP. The packaged gate
also exercises native upgrade paths against the new candidate version.
The unchanged historical expected-red proof does not need another run for
the version-only preparation. Bind the resulting receipt to the exact final
source, ZIP and verification outputs; prior 3.0.4 package hashes are not proof
of the 3.0.5 package identity.

Package from a clean reviewed source with `bash extension/package-extension.sh`.
The canonical outputs are `dist/ClassPilot-v3.0.5.zip` and its matching
`.sha256` record. Retain the exact source revision/tag, SHA-256, allowed-file
inventory and validation receipt beside the delivered artifact. The complete
package gate is required; `--verify-only` alone is not its replacement.

After review, deliver those exact verified bytes and their receipt to
`C:\GitHub\ClassPilot\dist`. Preserve every older versioned archive, including
the separately reviewed 3.0.4 ZIP. Refuse a different existing 3.0.5 ZIP rather
than overwriting it. Update `dist/classpilot-extension.zip` only to the final
verified 3.0.5 bytes, retaining its prior identity in the delivery receipt.
Do not change the primary checkout's source while delivering artifacts.

## Release boundaries

This is local candidate preparation, with no Store upload or publication.
Immediately before any future authorized upload, confirm the live version
and pending submissions in the authenticated Developer Dashboard for extension
`iggbfegfcjkfieoemeolfmfnapepalca`; a previously uploaded version cannot be reused.
Use the exact ZIP from the final clean, reviewed, tagged release source.

API/web deployment, capability enablement, Store publication and installed
managed-device adoption are separate events. Desktop browser checks do not
establish managed ChromeOS acceptance, fleet capacity or a monthly AWS bill.
The local typing examples demonstrate lossless byte savings, not a measured
2,000-student workload. No paid AWS load testing is required or authorized here.

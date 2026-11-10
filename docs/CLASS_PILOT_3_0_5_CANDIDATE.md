# ClassPilot 3.0.5 telemetry and screenshot efficiency

The Chromebook candidate is **3.0.5**, with Chrome **120** as its minimum.
It retains the reviewed 3.0.4 class-transition recovery and adds the efficiency
work implemented through runtime source
`77c88465e337b5fb922658f714ba76674365b943`, based on main
`c0a21a42654d2a0f8b4778f33c34547fdba668f5`. The original version-only 3.0.5 preparation changed only
the coordinated version guards and release documentation. The November 10
selected-student preview addition below extends that unsubmitted candidate.
The root application
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

The efficiency predecessor introduced no permission, managed-policy key,
image-quality reduction, capture-cadence change, history reduction or global
pixel cache. Routine capture quality and cadence remain unchanged by the
selected-detail addition below. Authentication,
school/student/session/context/revision fences are rechecked after asynchronous
work. Pixels stay in bounded in-memory capture state and are not persisted by
the extension. Safety evidence retains its existing full-image path.

SchoolPilot owns rollout, authorization, server storage and teacher decoding.
The child capabilities require their scoped-authority, transport, reference
and tracking-lease parents. Windows continues to filter the unsupported
Chromebook transport/reference/delta capabilities. Advertising a capability
does not enable it for a school, distribute this ZIP or establish device adoption.

### Selected-student detail previews — November 10, 2026

The optional `screenshotPolicy.detailPreview` object grants an exact selected
student a short-lived detail capture under the existing negotiated scoped
authority, tracking-window and active-observation parents. It requires
`mode: 'selected_student'`, a 32-character base64url `leaseId`, a positive
`expiresInSeconds` no greater than 20, `intervalSeconds: 5`, `maxWidth: 1920`
and `jpegQuality: 90`. Its local deadline is additionally bounded by the parent
tracking and active-view leases and reduced by request round-trip time.
Teaching and scheduled supervision contexts retain their exact authority and
control revision. Report-only observation retains ordinary thumbnails and
native-size zoom; this candidate does not implement the separately gated
read-only observation capability. Windows omits this unsupported capture path.

Only a current detail lease permits a separate native JPEG90 capture, at most
once per five seconds and serialized against ordinary capture with native API
spacing. The native pixel mutex is released after capture and the post-capture
tab fence; a pending detail HTTP response cannot block ordinary thumbnails.
The image preserves aspect ratio and native size up to 1920 pixels.
An encoding failure or data URL over 800,000 characters skips detail while
ordinary thumbnails continue. Detail uploads use full-image HTTP with
`captureKind: 'detail_preview'` and `detailPreviewLeaseId`; they never use the
thumbnail reference/delta cache or safety-evidence path. Thumbnail acquisition
remains JPEG50 followed by the existing 640-pixel JPEG0.6 encoder unchanged.

Authentication, context, revision, lease and tab fences are checked around
asynchronous capture and encoding and before upload. Detail lease replacement,
expiry, an exact observation-policy refresh or authentication retirement aborts
the optional detail request. A fresh authenticated heartbeat must regrant it.
The detail acquisition timestamp uses the policy's server-clock offset, fixed
as `serverTime - responseReceivedAt`; this preserves actual acquisition timing
on skewed device clocks without changing routine thumbnail timestamps. Pixels
remain in bounded memory only. SchoolPilot separately authorizes visible
viewers and stores detail images outside the grid thumbnail/reference stores.

The source and full packaged telemetry gates now include focused detail lease,
revocation, cadence and payload tests plus an actual Chrome native capture of
a synthetic worksheet. The browser gate checks a 1920-pixel detail, a separate
640-pixel routine thumbnail, five-second throttling and release. Synthetic
comparison images and measured dimensions/latency are saved under ignored
`artifacts/detail-preview/`; these are functional browser evidence, not managed
ChromeOS or fleet acceptance.

## Validation and artifact identity

The efficiency predecessor `77c8846` passed Node 24 type checking, 209 unit tests, build,
48 focused transport/reference/delta tests, real packaged Chrome captures and
exact recovery, Windows channel/package/Chrome/Edge parity, the complete source
Chrome behavior/recovery gate and 20 historical expected-red cases. One initial
ACK diagnostic fixture captured an empty synthetic retry; unchanged ACK code
passed four isolated reruns and the complete second source gate. Do not omit
that first result when preserving the validation receipt. Those results describe
the earlier efficiency implementation, not validation of the November 10 detail
addition or the identity of its replacement ZIP. The updated source requires a
new final receipt and distinct reviewed release tag; retain the older tag and
archive evidence unchanged.

For the final 3.0.5 source, run Node 24 `npm run check`, `npm test`,
`npm run build`, the focused telemetry tests, and the complete
`npm run test:extension:package` against the generated ZIP. The packaged gate
also exercises native upgrade paths against the new candidate version.
Run the full source `npm run test:extension:chrome`, including historical
expected-red proofs, for the selected-student preview change. Bind the receipt to the exact final
source, ZIP and verification outputs; prior 3.0.4 package hashes are not proof
of the 3.0.5 package identity.

Package from a clean reviewed source with `bash extension/package-extension.sh`.
The canonical outputs are `dist/ClassPilot-v3.0.5.zip` and its matching
`.sha256` record. Retain the exact source revision/tag, SHA-256, allowed-file
inventory and validation receipt beside the delivered artifact. The complete
package gate is required; `--verify-only` alone is not its replacement.

After review, deliver those exact verified bytes and their receipt to
`C:\GitHub\ClassPilot\dist`. Preserve every older versioned archive, including
the separately reviewed 3.0.4 ZIP. The operator confirmed this 3.0.5 candidate
has not been submitted and authorized updating it on November 10. Before
replacing a different existing 3.0.5 ZIP, archive its exact bytes, SHA-256 and
prior receipt and record the supersession explicitly. Update
`dist/classpilot-extension.zip` only to the final
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

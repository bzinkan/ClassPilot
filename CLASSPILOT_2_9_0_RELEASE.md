# ClassPilot 2.9.0 startup recovery candidate

Version 2.9.0 carries 2.8.9 forward unchanged and adds one correction: startup
recovery. When a supported startup storage operation fails temporarily, recovery
now resumes once its dependency returns, and an explicit Retry is never trapped
behind an abandoned startup operation. No Chrome permission, managed-policy key,
endpoint, screen, wording, button or support code is added or changed.

The public Chrome Web Store listing `iggbfegfcjkfieoemeolfmfnapepalca` reported
version 2.8.8 on September 15, 2026 before the 2.8.9 upload; it will read 2.8.9
once that upload is processed. Recheck the
live Store version immediately before any future upload; installed Chromebook
versions and Store publication are separate evidence.

This candidate update does not tag, package, upload, publish or activate the rollout.
The canonical future artifact is
`dist/ClassPilot-v2.9.0.zip`, produced only by the repository packaging script
from a clean, reviewed, tagged release commit during the authorized release.
`ClassPilot-v2.8.9.zip` and every earlier 2.8.x artifact, SHA-256 record and
release note remain retained and unchanged.

The September 15 intermittent pre-form Connecting incident remains unconfirmed.
This release fixes independently reproduced startup-recovery failures. Do not
present it as that incident's confirmed root cause or as proof of recovery on
the affected Chromebook.

## Carried over unchanged from 2.8.9

Scheduled classroom support is unchanged. Deploy the compatible SchoolPilot
API/worker and additive `classpilot-scheduled-classroom-20260915` and
`classpilot-schedule-boundaries-20260915` migrations before activating scheduled
classroom tools. Keep `CLASSPILOT_SCHEDULED_CLASSROOM_MODE=off` until a separately
authorized rollout. The extension must negotiate `scheduledClassroomV1` with
`scopedAuthorityChecksV1`; installing this version alone does not grant tools.
Ad hoc supervision and older clients retain their existing behavior.

Live View remains backend-only; the teacher Live View UI stays disabled even
when the scheduled classroom rollout is enabled. The backend and extension
retain typed negotiation, capture and stale-authority guards for compatibility.
This candidate does not expose Live View in the Dashboard.

2.8.8's actionable policy-refresh recovery and owned startup-storage retries,
2.8.7's bounded sign-in recovery and versioned page-controller handover, and all
earlier reviewed behavior are retained. Protocol details are in
[SCHEDULED_CLASSROOM_PROTOCOL.md](SCHEDULED_CLASSROOM_PROTOCOL.md); the 2.8.9
candidate gate is in [CLASSPILOT_2_8_9_RELEASE.md](CLASSPILOT_2_8_9_RELEASE.md).

## The startup recovery correction

In operator terms:

- A completed native storage failure during startup produces the existing
  actionable card with a support code. It recovers on Retry, or through bounded
  backoff, once storage works again.
- A storage operation that never reports back is reconciled by a fresh read
  after 9 seconds instead of holding startup open indefinitely, and a write
  whose callback fails after it already committed is reconciled the same way
  at once, so a landed write is never repeated. Explicit Retry is never
  trapped behind an abandoned operation. The bound is per operation: a startup
  that meets several stalled operations in sequence takes correspondingly
  longer than 9 seconds to become actionable.
- Managed-policy churn is bounded: repeated policy changes during startup cannot
  multiply recovery work or stack retries.
- A policy change arriving between the startup snapshot and credential
  restoration joins recovery for the current authority instead of stranding the
  gate on the superseded one.
- Authentication cleanup is replayed in full from the existing crash marker; it
  is never resumed piecemeal.

Timing: `chrome.alarms` floors packed-extension alarms at 30 seconds. The
2-second and 5-second backoff tiers are therefore page-driven, and unattended
recovery, with no open page driving a retry, begins at 30 seconds.

Residual, not covered: a WebSocket/offscreen disconnect that never completes is
outside this correction; it keeps its own fail-private close.

Unchanged: every screen, wording, button and support code from 2.8.9
(`AUTH_GATE_POLICY_TIMEOUT`, `AUTH_GATE_POLICY_UNAVAILABLE`,
`AUTH_GATE_STARTUP_TIMEOUT`, `AUTH_GATE_RPC_TIMEOUT`, `AUTH_GATE_RPC_UNAVAILABLE`,
`AUTH_GATE_CONTEXT_INVALIDATED`, `AUTH_GATE_SERVER_TIMEOUT`,
`AUTH_GATE_LOGIN_PENDING`, `AUTH_GATE_UNAVAILABLE`). No new Chrome permission,
managed-policy key, endpoint, reload or update-timing change, or off-device
telemetry. There is no SchoolPilot deployment or database migration associated
with this extension candidate. When controller ownership cannot be proved during
an in-place update, the explicit manual page reload remains the fallback; it is
not seamless replacement.

On-device diagnostics: `authGateDiagnosticsV1` gains the causes `reconciled`,
`stalled`, `superseded_joined` and `policy_churn`. The 20-record limit and six
fields (`timestamp`, `extensionVersion`, `stage`, `cause`, `elapsedMs`,
`attemptCount`) are unchanged. Records still contain no identity, credential,
URL or configuration value and never leave the device.

## Candidate verification

Require `npm run check`, `npm test`, `npm run build`, and
`npm run test:extension:chrome` on the exact candidate source. The Chrome gate
retains the scheduled classroom, startup recovery and same-extension-ID upgrade
checks. Also require `npm run test:extension:red-on-old`: a checked-in gate that
proves each new recovery case fails on unmodified 2.8.9 sources (the Chrome gate's
`test:extension:recovery` run is what proves the same cases pass on 2.9.0). A
recovery test that passes on both is not evidence of this correction.

Release guards in `server/__tests__/extension-release.test.ts` pin the 2.8.9
permission lists, managed-policy schema keys, auth-gate screen wording, support
codes, and the absence of any update-check, reload or beacon call in extension
sources.

When preparing the release package, require source/ZIP byte equality,
the versioned artifact and SHA-256 record, and `npm run test:extension:package`
against the unpacked ZIP, including scheduled classroom checks. Retain source
commit/tag and CI receipts; preserve prior versioned artifacts and release notes.
Never replace a prior versioned ZIP with different source bytes.

Record whether each upgrade uses cooperative replacement or the explicit manual
reload fallback. A test that requires manual reload does not establish seamless
replacement on managed ChromeOS. Automated Chromium does not establish
enterprise ChromeOS policy behavior.

## Managed-Chromebook operator gate

**HARD STOP.** Submit with deferred publishing. Publish only after all three of
the following are recorded on the exact reviewed artifact:

1. Two controlled managed Chromebooks: one managed guest session and one
   in-place 2.8.9-to-2.9.0 upgrade under the same extension identity. Record
   ChromeOS version, installed extension version, test time and session mode
   without student credentials or identities. Verify cold startup, sign-in,
   sign-out, subsequent sign-in and normal worker suspension. Exercise a
   controlled network interruption and policy refresh: require one visible
   recovery action, one protected gate and no duplicate submissions, and confirm
   the form recovers when the temporary dependency returns.
2. One previously affected Chromebook observed through a fresh guest session on
   2.9.0, with `authGateDiagnosticsV1` captured before that session ends; a
   managed guest session's storage does not survive sign-out. If inspection is
   permitted, read only its last 20 records and six fields. Do not dump Chrome
   storage or policy settings.
3. Recheck the live Store version immediately before upload. It will read 2.8.9
   after tonight's upload; stop if it conflicts with this artifact. Record
   installed Chromebook versions separately from Store publication.

Preserve all 2.8.x artifacts, hashes and release notes. Observe natural sign-ins
and class activity after adoption; do not infer success for an affected
Chromebook from aggregate HTTP successes elsewhere. Client-only faults can remain
invisible in AWS logs. Submission, deferred review, publication and any later
school capability rollout require their own authorization.

The paired backend deployment and rollback procedure is owned by SchoolPilot's
`docs/CLASSPILOT_AUTOMATIC_CLASS.md`; SchoolPilot deployment does not publish the
Chrome extension.

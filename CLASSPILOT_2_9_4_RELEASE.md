# ClassPilot 2.9.4 worker wake recovery candidate

Version 2.9.4 is an unsubmitted correction to worker startup recovery. A
completed failure cannot strand startup on its own policy barrier or release
partially restored authentication. Recovery verifies a local signed-out state
and current managed policy before offering fresh sign-in. The blocked screen
also provides **Details for IT** and **Copy diagnostics** without DevTools.
There is no new Chrome permission, managed-policy key, endpoint, or off-device
extension telemetry. Existing primary support codes remain compatible.

## What was observed

On September 25, 2026 a managed Chromebook running 2.9.3 showed the startup
card ("ClassPilot can't connect right now", support code
`AUTH_GATE_STARTUP_TIMEOUT`). The console showed `Wake-up error` and repeated
timeouts. The operator reported that a full session restart did not resolve
the device. Its exact trigger remains unconfirmed: the original exception was
reduced to `Error`, and these local failures are not sent to AWS.

An independent reproduction on v2.9.3 showed that a completed restoration
failure can leave the wake's managed-policy promise unresolved. That mechanism
is consistent with the symptom, but is not proof of the device's exact cause.
Review of the first unsubmitted 2.9.4 candidate (`16320c6`) then reproduced two
additional defects: partially adopted authentication could release the gate,
and policy recovery could repeat unbounded credential migration. This candidate
corrects those paths as well.

## What 2.9.4 changes

- Restoration has an explicit outcome. Only completed, verified restoration
  may follow the healthy authenticated path; remaining in-memory credentials
  and absent crash markers cannot substitute for that proof.
- A completed current-owner failure settles its policy barrier, fences partial
  authentication, and runs strict local clear, fresh managed-policy
  application/persistence, then revision/roster/readiness publication. Recovery
  pauses automatic registration and requires fresh credentials while preserving
  valid exact-bound recovery capabilities.
- Recovery's policy phase reads only native non-authentication configuration
  and binding data. It never calls credential migration. Completed phases are
  retained across retries; concurrent Retry/alarm work joins the current owner.
- The nine-second RPC deadline reports failure without cancelling underlying
  authentication work. The 30-second wake watchdog is diagnostic only when
  no tracked startup owner already exists: elapsed time never authorizes
  recovery takeover or unlocks browsing. Composite operations retain ownership until they settle; individual
  native operations retain existing safe intent reconciliation and backoff.
- Existing failure responses carry optional allowlisted `supportDetails`
  directly from worker memory. The secure frame and fallback preserve them and
  provide selectable/copyable support text. The first causal error survives
  later timeout reports. Worker absence displays only known local evidence.
- `authGateDiagnosticsV1` remains a 20-record on-device buffer. Startup step and
  native storage failure classes contain fixed identifiers only; no student or
  device identifiers, PINs, credentials, URLs, storage values, raw messages, or
  stacks appear in support details. Clipboard denial has a manual-copy fallback.

## SchoolPilot #502 compatibility

SchoolPilot #502 ends a teacher-targeted student session even when its device
is asleep, has no realtime snapshot, or cannot receive a command frame. Its
merge is verified; production deployment is a separate operational check.
The extension retains existing exact-bound sign-out and heartbeat rejection
handling, with no new protocol capability. Local startup failure or a generic
401/403 does not invent proof that the server session ended. A server-ended
session's bearer/recovery capability cannot resume it; fresh credentials may
create a new session. Late cleanup and replies cannot clear a newer login.

## Verification gate

`npm run test:extension:red-on-old` retains the immutable v2.9.3 regressions and
historical v2.8.9 coverage. The separate `pr116-16320c6` fixture records the
unsubmitted PR candidate, not a published version. Its correction cases must
fail on their declared regression assertion before passing on repaired code;
spawn errors and process timeouts do not count as proof.

Required checks: `npm run check`, `npm test`, `npm run build`,
`npm run test:extension:chrome` (including red-on-old), package byte comparison
and `npm run test:extension:package`, and `git diff --check`. Cross-repository
validation uses non-production SchoolPilot code containing #502. Managed-device
acceptance remains a separate release gate: fresh session, same-ID upgrade,
teacher sign-out while offline, and the affected Chromebook when available.

## Release handling

This candidate update does not tag, upload, publish or activate the rollout.
Local packages produced for integration verification are test candidates only.
The canonical future artifact is `dist/ClassPilot-v2.9.4.zip`, produced only by
the repository packaging script from a clean, reviewed, tagged release commit
during the authorized release. `ClassPilot-v2.9.3.zip` and every earlier
artifact, SHA-256 record and release note remain retained and unchanged.
Earlier local 2.9.4 test packages from `16320c6` are superseded and must not be
submitted. Retain them only as labeled review evidence. Recheck the live Store
version immediately before any future upload; installed
Chromebook versions and Store publication are separate evidence. Submit with
deferred publishing only after managed acceptance and final review. Use the
on-screen support details during validation without requiring DevTools.
When controller ownership
cannot be proved during an in-place update, the explicit manual page reload
remains the fallback; it is not seamless replacement.

## Carried over unchanged from 2.9.3

Class tools, the 2.9.3 timer placement correction, the 2.9.1 class chat
controls and the 2.9.0 startup recovery are unchanged. Scheduled classroom
support is unchanged. Deploy the compatible SchoolPilot API/worker and additive
`classpilot-scheduled-classroom-20260915` and
`classpilot-schedule-boundaries-20260915` migrations before activating scheduled
classroom tools. Keep `CLASSPILOT_SCHEDULED_CLASSROOM_MODE=off` until a separately
authorized rollout. The extension must negotiate `scheduledClassroomV1` with
`scopedAuthorityChecksV1`; installing this version alone does not grant tools.
Ad hoc supervision and older clients retain their existing behavior.

Live View remains backend-only; the teacher Live View UI stays disabled even
when the scheduled classroom rollout is enabled. The backend and extension
retain typed negotiation, capture and stale-authority guards for compatibility.
This candidate does not expose Live View in the Dashboard.

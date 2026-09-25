# ClassPilot 2.9.4 worker wake recovery candidate

Version 2.9.4 carries 2.9.3 forward unchanged and adds one correction: worker
wake recovery. When the extension's service-worker wake fails or is abandoned
before its managed-policy barrier settles, startup readiness now recovers on
its own instead of waiting on that barrier forever. No Chrome permission,
managed-policy key, endpoint, screen, wording, button or support code is added
or changed.

## What was observed

On September 25, 2026 a managed Chromebook running 2.9.3 showed the startup
card ("ClassPilot can't connect right now", support code
`AUTH_GATE_STARTUP_TIMEOUT`) and Retry never cleared it. Its service-worker
console showed the extension update event followed by `Wake-up error` from the
wake's own failure handler: the wake had failed, and the 2.9.0 readiness owner
was left in flight awaiting the failed wake's policy barrier. Retry and the
recovery alarm re-run only owners that have failed, so nothing could re-run it,
and the frame's polling kept the worker alive so the wake never re-ran. The
device recovered only when its Chrome session ended. The failed wake's error
was sanitized to `Error`, so the log could not name the step or the cause.

## What 2.9.4 changes

- A wake that fails retires its own policy barrier before the tracked
  coordinator owns readiness.
- Startup readiness for a retired wake derives the recovery flags from the
  durable crash markers with one bounded read, applies managed policy once
  through the same bounded direct revalidation a managed change uses, replays
  the signed-out clear and publishes readiness. A verified authenticated
  startup is never cleared by this recovery; a completed marker-read failure
  stays protected and retryable.
- A wake that neither finishes nor fails within 30 seconds is retired the same
  way by a wake watchdog.
- The remaining unbounded startup storage operations are bounded like every
  other startup storage operation (2.9.0's reconcile by a fresh read after
  9 seconds): the pre-2.7.3 local credential purge, manual-context persistence
  and retired-storage cleanup during credential adoption, and the monitoring
  redaction restore.
- Diagnostics: on-device `authGateDiagnosticsV1` gains the causes `wake_failed`
  and `wake_abandoned`, each with an optional seventh field, `detail`, naming
  the startup step (a fixed identifier such as `auth_snapshot`, never data);
  `chrome.storage.session` gains `authGateWakeFailureV1` (step, cause,
  sanitized failure class, elapsed time); native storage failures are logged as
  `STORAGE_QUOTA_EXCEEDED`, `STORAGE_IO_ERROR`, `STORAGE_CONTEXT_INVALIDATED`
  or `STORAGE_FAILED`, never as the native message. The same 20-record limit
  applies, and there is still no off-device telemetry.

## Verification gate

`npm run test:extension:red-on-old` now proves the two new browser cases
(`wake-failure-before-policy` and `wake-parked-before-policy`) trip against the
immutable v2.9.3 snapshot (`scripts/fixtures/auth-recovery-2.9.3.json.gz`,
verified by its receipt) before they are trusted green on the candidate; the
2.9.0 cases keep tripping against v2.8.9. The VM recovery suite adds the wake
failure, watchdog, derived-flags and bounded-purge cases.

## Release handling

This candidate update does not tag, package, upload, publish or activate the rollout.
The canonical future artifact is `dist/ClassPilot-v2.9.4.zip`, produced only by
the repository packaging script from a clean, reviewed, tagged release commit
during the authorized release. `ClassPilot-v2.9.3.zip` and every earlier
artifact, SHA-256 record and release note remain retained and unchanged.
Recheck the live Store version immediately before any future upload; installed
Chromebook versions and Store publication are separate evidence. Submit with
deferred publishing, then observe the previously affected Chromebook through a
fresh managed session on 2.9.4 with `authGateDiagnosticsV1` and
`authGateWakeFailureV1` captured before publishing. When controller ownership
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

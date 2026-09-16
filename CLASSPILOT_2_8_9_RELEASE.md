# ClassPilot 2.8.9 scheduled classroom candidate

Version 2.8.9 prepares extension support for scheduled testing and scheduled
coverage under their real supervision authority. It preserves 2.8.8 startup
recovery and the existing teaching-session behavior. No Chrome permission or
managed-policy key is added.

The public Chrome Web Store listing `iggbfegfcjkfieoemeolfmfnapepalca` was checked
on September 15, 2026 and reported version 2.8.8, updated that day. Recheck the
live Store version immediately before any future upload; installed Chromebook
versions and Store publication are separate evidence.

This candidate update does not tag, package, upload, publish or activate the rollout.
The canonical future artifact is
`dist/ClassPilot-v2.8.9.zip`, produced only by the repository packaging script
from a clean, reviewed, tagged release commit during the authorized release.

## Dependencies and behavior

Deploy the compatible SchoolPilot API/worker and additive
`classpilot-scheduled-classroom-20260915` and `classpilot-schedule-boundaries-20260915`
migrations before activating scheduled
classroom tools. Keep `CLASSPILOT_SCHEDULED_CLASSROOM_MODE=off` until a separately
authorized rollout. The extension must negotiate `scheduledClassroomV1` with
`scopedAuthorityChecksV1`; installing this version alone does not grant tools.
Ad hoc supervision and older clients retain their existing behavior.

Every action has one real `teachingSessionId` or `supervisionContextId`.
Student chat, hands, polls and command acknowledgements retain their original
context and control revision. Restored timer/poll overlays preserve the exact
browser binding and staff-assignment authority, surviving ordinary restrictions
and end-time extensions while clearing on expiry or reassignment. Screenshot
leases and active-view cadence remain bound to current, unexpired authority.

Live View remains backend-only; the teacher Live View UI stays disabled even
when the scheduled classroom rollout is enabled. The backend and extension
retain typed negotiation, capture and stale-authority guards for compatibility.
This candidate does not expose Live View in the Dashboard.

## Candidate verification

Require `npm run check`, `npm test`, `npm run build`, and
`npm run test:extension:chrome` on the exact candidate source. The Chrome gate
includes scheduled popup/content actions, overlay restoration, stale revisions,
browser/context replacement, capability rejection, and media expiry. Preserve
existing startup recovery and same-extension-ID upgrade checks.

When preparing the release package, require source/ZIP byte equality,
the versioned artifact and SHA-256 record, and `npm run test:extension:package`
against the unpacked ZIP, including scheduled classroom checks. Retain source
commit/tag and CI receipts; preserve prior versioned artifacts and release notes.

Validate the exact package on at least two controlled managed Chromebooks before
Store submission, including a managed guest session and in-place upgrade.
Automated Chromium does not establish enterprise ChromeOS policy behavior.
Exercise scheduled boundaries, student/staff reassignment, chat, hands, timers,
polls, screenshots and sign-out with the compatible backend in an authorized
test scope. Keep Live View UI disabled. Submission, deferred review, publication
and any later school capability rollout require their own authorization.

Protocol details are in [SCHEDULED_CLASSROOM_PROTOCOL.md](SCHEDULED_CLASSROOM_PROTOCOL.md).
The paired backend deployment and rollback procedure is owned by SchoolPilot's
`docs/CLASSPILOT_AUTOMATIC_CLASS.md`; SchoolPilot deployment does not publish the
Chrome extension.

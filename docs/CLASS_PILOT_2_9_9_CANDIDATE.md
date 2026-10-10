# ClassPilot 2.9.9 candidate: safe poll replay

Status: implementation candidate. This record does not claim a Store
publication, managed Chromebook acceptance, production activation, or completed
school-day observation. Version 2.9.9 is provisional until the current Store
version and pending submissions are checked immediately before upload.

## Behavior

The extension advertises `pollReplaySafeV1` under protocol 3 and requires scoped
authority negotiation. A server-generated positive `transientOrder` orders poll
starts and closes for the exact authenticated student binding and classroom.
The worker persists this cursor and poll state before acknowledging receipt on
the negotiated ordered path. Re-delivery preserves the original expiry and any
chosen answer. A close watermark survives overlay expiry and worker suspension.

The first selected answer is saved before HTTP submission. Failed delivery keeps
that answer pending, offers an explicit retry, and schedules a bounded automatic
retry while authority is restored. A canonical `POLL_ALREADY_ANSWERED` response
completes the saved answer using the server's existing first-write-wins result.
Identity or classroom changes retain the existing authority and cleanup fences.

The canonical renderer preserves typed drafts for the same poll and represents
pending and confirmed answers honestly. A newer close or confirmed answer retires
an older visible poll even if the intervening start was missed. Historical live
commands without ordering metadata cannot replace an established ordered cursor.
Already-open content is upgraded through the existing page lifecycle, without
reloading student work; snapshot hydration must establish current authority
before rendering.

This candidate adds no permission, managed-policy key, or collected data. It
retains the extension identity and Chrome 120 minimum. Socket tuning and timer
client behavior remain the 2.9.8 implementation.

## Automated verification

The new core and actual Chromium suites cover durable receipt ordering, a crash
between persistence and ACK, pending answers across page reload and real MV3
suspension, delayed capability negotiation, canonical 409 completion, stale
starts/closes, historical no-order commands, legacy-to-ordered transitions,
cross-tab missed starts, and draft preservation.

An immutable 2.9.8 source fixture exercises native upgrade on an existing
authenticated page. The upgrade keeps ordinary page work and restores the
current poll after trusted sign-in. Manual browser-session credentials retain
the existing release-and-sign-in behavior across native extension updates.

Local browser verification used Chromium 151. The signed-out native 2.9.8
upgrade still exercised the existing explicit ownership fallback before fresh
PIN sign-in; it does not establish automatic signed-out page takeover. The
authenticated poll delivery case upgraded the existing page without reloading
its work. The Chrome 120/133/152/stable CI matrix and physical managed-device
sleep/wake and Store-update acceptance remain separate pending checks.

The SchoolPilot integration test can export start/close wire frames produced by
real persistence, replay eligibility, authority checks, and the production frame
builder. Set `CLASSPILOT_REPLAY_FRAME_FIXTURE_OUTPUT` when running that test, then
pass the resulting path as `CLASSPILOT_REPLAY_FRAME_FIXTURE` to the extension
Chromium suite. The harness may rebase only fixture identity/context and clocks;
the production command schema and ordering fields must remain intact.

Run `npm run test:extension:poll-replay` for core and Chromium checks. The
existing Chrome behavior CI aggregate includes this lane. Verify the packaged
extension as well as source, and record the final source SHA, archive SHA-256,
Chrome version, commands, and outputs with the candidate artifact. That receipt
must identify any checks still pending; this document is not a substitute.

## Release gates and rollback

1. Merge and deploy the corrected SchoolPilot backend with replay off. Deploy
   [SchoolPilot PR 635](https://github.com/bzinkan/SchoolPilot/pull/635) and confirm
   teacher dashboards have reloaded before extending delivery deadlines.
2. Confirm the live Store version and pending submissions immediately before
   upload; use the next unused patch version if 2.9.9 is no longer available.
   Build a clean reviewed versioned archive, create its matching source tag,
   and bind the archive and acceptance evidence to that source. SchoolPilot
   deployment does not publish this extension.
3. Perform exact-package acceptance on a managed Chromebook, including restart,
   crash, offline response, mixed 2.9.8/successor fleet, and existing-page upgrade
   behavior. Ordinary automated Chromium checks do not satisfy this gate.
4. Follow the guarded profiles in
   [SchoolPilot PR 636](https://github.com/bzinkan/SchoolPilot/pull/636): one full
   school day with timer replay, followed by the same school's poll pilot only
   after real package/device evidence and confirmed capability adoption. Poll
   replay must remain unavailable to 2.9.8 clients. No global activation is part
   of this candidate.
5. Roll back server replay with `transient-replay-off`. Future commands return
   to 15-second delivery deadlines; existing deadlines remain unchanged. A
   Store correction is a separate successor release. The independent
   [tile-request hotfix](https://github.com/bzinkan/SchoolPilot/pull/639) may remain.

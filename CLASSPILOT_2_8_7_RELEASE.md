# ClassPilot 2.8.7 sign-in recovery

This release bounds startup and sign-in waiting, retries managed policy through
fresh coordinated attempts, and safely retires obsolete page controllers.
It addresses verified failure paths. It does not establish the cause of the
September 8 Chromebook interruption or promise access while Chrome, school
policy, authentication persistence or the network remains unavailable.

## Behavior and boundaries

- Managed reads: 3 seconds; worker gate responses: 9 seconds; page/frame RPC:
  10 seconds. Existing HTTP/body timeout remains 5 seconds.
- Automatic recovery backs off 2, 5, 15, then 30 seconds. Concurrent callers
  share worker work. Explicit Retry may bypass a delay and never duplicates an
  active attempt. Timed-out sign-in mutations are never automatically replayed.
- Timeout and missing policy are distinct: unavailable dependencies remain
  protected and retryable; a verified incomplete setup remains setup-required.
  No cached authorization, fabricated revision or managed-policy proof can
  release the gate. Durable auth invalidation/commit barriers remain authoritative.
- Same-version page injection reconciles one controller. Cooperative replacement
  disposes owned resources. Legacy 2.8.6 replacement may reload a verified blocked,
  signed-out, non-kiosk top-level document once per installed version/tab, after
  its attempt marker is stored. This can discard underlying unsaved page work.
  Unreachable ownership requires a manual browser reload; it never broadens
  automatic reload scope.
- Ordinary worker wake, timeout and reinjection add no sign-outs. The existing
  deliberate manual-session boundary on extension updates remains unchanged.
  No runtime reload loop or update-timing control is added.
- Diagnostics retain at most 20 allowlisted records in trusted session storage,
  with an in-memory fallback and one-minute stage/cause deduplication. They do
  not contain credentials, identities, policy values, URLs or raw error text.
  Client-only faults can remain invisible in AWS logs.
- No new Chrome permission, managed-policy key, backend endpoint or database
  format is required. Restriction, portal-first, roster recovery and teacher
  command contracts remain in force during mixed-version adoption.

## Automated release evidence

Require type checking, complete tests, real-Chrome integration tests, build,
source/archive byte equality, package integration tests and clean diffs.
`npm run test:extension:recovery` includes the focused deadline, diagnostics,
ownership, protected remount and managed-mode browser fixtures. It runs in the
full Chrome gate and against the unpacked release artifact.
The new recovery fixtures must include managed reads that never call back,
late callbacks, concurrent retries, pending authentication writes, lost RPC
replies and an in-place same-ID 2.8.6-to-candidate update. Test the manifest's
managed startup path, not merely the unpacked loopback bypass.

After review and green post-merge CI, tag the exact release commit `v2.8.7`.
Package from a clean checkout of that tag using `extension/package-extension.sh`.
Retain the versioned ZIP, its SHA-256, the source/tag identity and gate receipts.
Never replace historical versioned artifacts with a new build of different code.

The automated same-ID upgrade uses Chromium's unpacked-extension loader with
the same directory and browser profile. Its managed API is a test fixture.
The observed legacy outcome was protected manual reload because Chrome did not
expose provable ownership of the obsolete controller. Automatic legacy reload
preconditions are covered by focused tests; ChromeOS and Store-delivered upgrade
behavior still require the controlled hardware checks below.

## Managed-Chromebook gate — operator validation required

Automated Chromium is not evidence that enterprise ChromeOS policy or the
public Store upgrade works on the live school. Before school-wide publication,
test the exact candidate on at least two controlled managed Chromebooks,
including a managed guest session. Record ChromeOS and extension versions,
test times and outcomes in private release evidence, without student credentials.

1. Cold-start at the school sign-in screen, sign in, sign out, and sign in again.
   Confirm correct roster and existing Waypoint/Flight Path protection.
2. Upgrade from 2.8.6 under the same extension identity while a gate is open.
   Confirm recovery to one usable protected gate, at most one guarded reload,
   and the unchanged manual-session cleanup behavior.
3. Retry through a temporary network interruption; confirm bounded feedback,
   no automatic page reload, and successful recovery when connectivity returns.
4. Change managed policy through the controlled test configuration. Confirm
   removed/changed authority cannot be resurrected by late replies or cached data.
5. Verify kiosk exclusion, normal worker suspension, teacher overlays/commands,
   roster recovery, and an existing restricted sign-in after recovery.

Mark unavailable hardware checks PENDING. A software-verified ZIP can be handed
to the operator with that limitation; it is not school-wide publication clearance.

## Operator upload and observation

The operator controls CWS submission. Reconfirm the public listing's live version
immediately before upload; submission, publication and installed-device adoption
are separate milestones. Upload only the reviewed `ClassPilot-v2.8.7.zip` matching
the retained digest. Observe actual sign-ins and class activity through the next
school day after adoption, separately from backend pool-recovery acceptance.

For a serious regression, stop wider adoption and retain failure diagnostics.
A Store roll-forward repair must use a higher accepted version and preserve
current authentication/data compatibility; republishing a lower version is not
an instant downgrade mechanism. Keep the prior ZIP and source evidence.

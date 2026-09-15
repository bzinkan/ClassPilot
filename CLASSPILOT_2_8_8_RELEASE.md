# ClassPilot 2.8.8 startup recovery candidate

This candidate repairs reproducible extension startup and recovery defects found
while investigating the September 15 intermittent pre-form Connecting reports.
One affected Chromebook was confirmed to run 2.8.7 in a managed guest session.
The observed AWS requests were healthy; the precise failure on that Chromebook
has not been established from its local diagnostic records. Do not present these
code fixes as a confirmed incident root cause or proof of device recovery.

## Changes under verification

- A failed managed-policy refresh must display a visible, actionable Retry state
  while retaining the authority fence. Both page controllers must acknowledge
  the current policy before the secure frame can become usable.
- The document-start managed read has a three-second deadline. A timeout never
  becomes an empty, valid school policy or permission to use cached authority.
- Completed failures in the initial native local/session reads and the revision
  or roster-context publication may retry through a tracked owner. An unresolved
  read or write remains in flight, and the original startup
  continuation retains its ordering. Authentication, credential submissions,
  migration cleanup and sign-out work are not automatically replayed.
- A managed authority change that supersedes the initial native snapshot before
  migration or credential adoption retires that old wake. Only successful exact
  cleanup and current policy/revision/roster work can complete signed-out
  readiness. This does not restart wakes superseded later in their lifecycle.
- The secure frame preserves a failed initial page request as an actionable
  error instead of starting a second loading deadline during handover.
- The unavailable screen exposes an allowlisted support code and preserves it
  while another retry is running. It contains no credential, identity, URL,
  configuration value or raw error text. A missing worker reply must not be
  described as a policy-read or server failure without that evidence.

Automatic recovery uses bounded backoff. Explicit Retry joins work already in
flight. Late responses, old policy acknowledgements and obsolete frames cannot
restore authority. Existing permissions, managed-policy keys, endpoints and
student authentication contracts remain unchanged. There is no AWS deployment
or database migration associated with this extension candidate.

## Validation and package identity

Require type checking, complete tests, managed-mode Chrome integration tests,
build, package byte equality and package integration checks, plus clean diffs.
Preserve the failing 2.8.7 reproductions separately from successful candidate
tests. Tests must verify actual visible/clickable recovery controls, recovery
after completed storage failures, continued protection for unresolved storage,
concurrent tabs, policy changes during startup, late callbacks and stale frames.
Include an in-place same-extension-ID 2.8.7-to-candidate upgrade as well as the
existing legacy 2.8.6 recovery coverage.

Record whether each upgrade uses cooperative replacement or the explicit manual
reload fallback. Chrome's inaccessible obsolete execution contexts cannot be
claimed as owned from DOM appearance alone. A test that requires manual reload
does not establish seamless replacement on managed ChromeOS.

After review, merge and green CI on the exact release commit, tag `v2.8.8` and
package from a clean tagged checkout. Deliver `ClassPilot-v2.8.8.zip`, SHA-256,
source/tag identity and test receipts. Preserve all historical release artifacts
and notes; never replace a prior versioned ZIP with different source bytes.

## Managed-Chromebook operator gate

Hardware validation is **PENDING** until recorded on at least two controlled
managed Chromebooks, including a managed guest session and an in-place upgrade.
Automated Chromium cannot substitute for enterprise ChromeOS validation.

1. Record ChromeOS and installed extension versions, test time and guest-session
   status without student credentials or identities.
2. Verify cold startup, sign-in, sign-out, subsequent sign-in and normal worker
   suspension. Confirm the form recovers when a temporary dependency returns.
3. Exercise a controlled network interruption and policy refresh. Require a
   visible recovery action, one protected gate and no duplicate submissions.
4. Upgrade a controlled device from 2.8.7 under the same extension identity.
   Verify normal update cleanup, recovery and the existing classroom controls.
5. Record the support code if recovery fails. If inspection is permitted, read
   only `authGateDiagnosticsV1` from trusted session storage, limited to its last
   20 records and six fields: `timestamp`, `extensionVersion`, `stage`, `cause`,
   `elapsedMs`, `attemptCount`. Do not dump Chrome storage or policy settings.

The operator controls Chrome Web Store submission. Reconfirm the live Store
version immediately before upload, and verify installed Chromebook versions
separately from Store publication. Observe natural sign-ins and class activity
after adoption; do not infer success for an affected Chromebook from aggregate
HTTP successes elsewhere. Client-only faults can remain invisible in AWS logs.

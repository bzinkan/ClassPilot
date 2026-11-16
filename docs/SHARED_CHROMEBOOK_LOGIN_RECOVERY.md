# Shared Chromebook sign-in recovery

This source repair investigates the November 16, 2026 report of a shared
Chromebook on ClassPilot 3.0.6 repeatedly showing sign-in until reboot. The
affected device/session was not identified. The regressions below reproduce
relevant defects in unchanged 3.0.6; they do not establish the incident's cause.

## Expired prior identity during a replacement login

A deliberate manual login reserves a new authentication generation before its
server response arrives. The prior student's manual timestamp remains present
until adoption. A concurrent `get-auth-state` or heartbeat expiry check could
start another clear against that old timestamp, advance the generation, and
reject the successful replacement login as superseded.

Both periodic expiry entry points now leave cleanup to an in-flight manual
login or already-running invalidation. An expired identity remains unavailable
to `hasStudentAuth()`, so browsing stays protected while the new login waits.
Ordinary expiry still clears when no replacement owns the transaction. Explicit
sign-out, policy changes and exact-bound response checks retain their authority.

The native MV3 regression is `scripts/test-extension-shared-login.mjs`. It uses
synthetic server responses and native Chrome storage, and checks one login
submission, successful replacement adoption, protected pending state, ordinary
expiry and duplicate expiry checks during a held invalidation write.

## Lost completion after a sign-in repaint

A newer status update during submission repaints the frame and correctly
retires the old callback. Previously that repaint also stopped read-only
confirmation. A missed completion push then left the frame in the unavailable
state until manual Retry.

The existing bounded retry timer now continues during uncertain confirmation.
It only reads current worker authority; it never resubmits credentials. The
frame tests cover a missed completion push, retry timing, a newer required
sign-in context, and late obsolete success callbacks/notifications. An invalid
extension context still requires the existing explicit recovery action.

## Single-request network deadline

The manual login's fetch and JSON body previously had no request deadline. A
server could return HTTP 200 headers and leave its body unfinished, parking the
authentication queue even after the frame's own response deadline elapsed.
The repair bounds headers and body together using the existing five-second
auth-request deadline and aborts the native request. It does not replay a PIN or
email/ID request. A later deliberate submission may retry after the failed
request settles. The existing exact-conflict-only managed-continuity fallback
and rate-limit handling remain separate.

The regression uses a real local HTTP server with stalled headers or partial
JSON, an actual MV3 worker and native storage. It verifies queue progress,
protected sign-in and later successful explicit login.

## Verification and release boundary

Verification uses Node 24.22.1, npm 11.7.0 and Playwright Chromium
151.0.7922.34. Each of the three new regressions failed at its declared
assertion against unchanged `d185a7511f6c63f2829a6609520ebeae9aeb70b7`.

| Check | Result |
| --- | --- |
| TypeScript, Vitest, prototype build | Passed; 20 files / 209 unit tests |
| Native sign-in frame | All 18 scenarios passed |
| Native replacement-login and stalled-response regressions | Passed from source and extracted test package |
| Packaged inventory | All 30 files matched source bytes |
| Independent code review | No actionable findings |
| Full source Chrome aggregate | Passed, including all 20 historical expected-red cases |

One initial packaged shared-login run timed out before Chrome published its
worker target. Its standalone rerun passed; the response and frame package
cases passed on their first run. The build retains its existing PostCSS and
large-chunk warnings. One historical expected-red run reported a Windows
temporary-profile cleanup lock; its isolated rerun failed on the intended old
startup-recovery assertion. The isolated test archive's SHA-256 is
`44c7ff971d2035133e9ae91823ee34e1f99724e0409cfc70f195133c1832f1fd`;
it is not a release artifact.

Native desktop Chromium tests do not establish managed ChromeOS acceptance. Confirm a shared-device
student handoff and scheduled class transition on a managed Chromebook before
fleet rollout.

This is an unreleased source repair. The manifest remains 3.0.6 for baseline
comparison; these modified bytes must not replace a reviewed or published
3.0.6 archive. A separately reviewed successor needs its own version, release
guards, clean tagged source, verified ZIP/hash, and Store publication/adoption
evidence. SchoolPilot API/web deployment does not distribute the extension.

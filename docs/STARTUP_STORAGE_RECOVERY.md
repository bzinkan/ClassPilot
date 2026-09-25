# Chrome compatibility and private recovery storage — 2.9.5 candidate

## Reported failure

The September 25, 2026 device evidence confirms ClassPilot 2.9.4 on Chrome
133.0.6943.132. Restarting the full session did not fix the device. Details for
IT showed first failure `session_recovery / Error`, then `recovery_clear`,
failed restoration, and repeated attempts under `AUTH_GATE_STARTUP_TIMEOUT`.

The released worker awaited `chrome.storage.local.setAccessLevel` and cached
its first rejection permanently. Chrome 133 does not provide local storage
access restriction; that support arrived in Chrome 140. Both restoration and
cleanup awaited the same rejected promise. This is a confirmed compatibility
defect consistent with the device evidence; acceptance on the affected
Chromebook remains required to establish that no additional failure exists.

Native Chrome 120 testing also exposed a recovery-frame navigation defect.
Changing only the frame URL fragment can preserve the failed document and its
captured nonce, leaving policy Retry unable to reconnect to a healthy worker.
Each frame instance now has a distinct query parameter as well as its nonce
fragment, forcing a fresh document while retaining the existing source and
nonce checks. The regression verifies replacement of the actual document.

Frame script verification is separate from policy readiness. A responsive,
nonce-verified frame can wait for current policy without exhausting the
10-second script-load deadline. New documents still receive a bounded
verification window; policy fences continue to prevent credential display
or browsing release until current authority is confirmed.

Sources: [Chrome 133 storage implementation](https://github.com/chromium/chromium/blob/133.0.6943.132/extensions/browser/api/storage/storage_api.cc),
[Chrome 140 storage implementation](https://github.com/chromium/chromium/blob/140.0.7339.80/extensions/browser/api/storage/storage_api.cc).

## Supported minimum

The candidate declares Chrome **120** as its minimum. It preserves the current
30-second background alarm cadence. Chrome 116 is the floor for consuming a
worker-created tab-capture stream in an offscreen document, but supporting
116–119 would require additional scheduling changes and separate validation.
The minimum is a compatibility boundary, not a recommendation to keep managed
devices on an old browser or a promise that every future Chrome release has
already been tested.

The operator reports a mixed fleet: affected Chromebooks on 133, most devices
on 152, and possibly one or two on 120 (not yet confirmed). Compatibility does
not depend on resolving the older devices' ChromeOS update issue.

Sources: [Chrome 120 alarms](https://developer.chrome.com/blog/chrome-120-beta-whats-new-for-extensions),
[tab capture stream restrictions](https://developer.chrome.com/docs/extensions/reference/api/tabCapture),
[offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen).
Unpacked extensions do not enforce production alarm frequency limits, so an
unpacked test alone cannot justify a lower minimum. Current dynamic network
rules are bounded below Chrome 120's 5,000-rule limit. Dynamic resource URLs
are only enabled by Chrome from 130; earlier versions use the static extension
origin, retaining secure-frame nonce/source checks but without that additional
installation-fingerprinting mitigation.

## Recovery storage

All supported versions use extension-origin IndexedDB for opaque durable
recovery capabilities. Active credentials and student identity remain in
trusted `chrome.storage.session`. Content-script IndexedDB belongs to the
host page's origin and cannot read the extension database. Modern local
storage restrictions are best effort; their availability is not a startup
prerequisite. Non-authentication local configuration and restriction metadata
remain in local storage; this change does not claim all local storage is
private on Chrome 120/133.

The database is `classpilot-private-recovery-v1`, with one `recovery` store and
`student-session-recovery` record. Migration commits a schema marker and
normalized capability state before deleting and verifying deletion of the
legacy `studentSessionRecoveryV1` key. Readiness and new capability writes wait
for that cleanup. An existing marker, including an empty tombstone, always
wins over legacy data. Restarting after commit but before deletion resumes
cleanup and cannot resurrect a cleared capability.

Transactions settle only after completion or abort. Pending operations retain
one owner; a timeout cannot authorize later work to bypass them. Completed
failures can retry. The worker's existing mutation queue and authentication
generation checks continue to protect newer logins from delayed cleanup.
An unavailable database keeps sign-in protected. Browser restart retains the
opaque recovery capability but still requires fresh credentials. Worker-only
restart can retain the current browser-session authentication. Storage loss
must degrade to protected fresh sign-in, never restoration from stale local
data. No new permission or network endpoint is introduced.

Source: [Extension storage origins and persistence](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies).

## Diagnostics and server authority

Details for IT includes fixed private-storage phases and failure codes, using
the existing optional sanitized support field. It never displays raw storage
errors, data, identities, tokens, or URLs. Unknown worker state stays absent
when only a page transport timeout is known. The first causal failure remains
visible. Copy diagnostics retains its selectable-text fallback.
Copy status and pending clipboard operations follow the currently displayed
sanitized details through repaints. A newer copy supersedes an older callback;
after recovery removes the details, stale callbacks cannot recreate them or
take focus from sign-in.

SchoolPilot #502's server-authoritative sign-out contract is unchanged. An
asleep or unreachable Chromebook does not prevent teacher sign-out on the
server. A revoked bearer or recovery capability cannot resume the ended
session; deliberate successful login can create a new session. Local startup
failure and a generic authentication rejection do not prove server sign-out.

## Validation and release boundary

The compatibility matrix runs all candidate behavior and package tests
on pinned Chrome for Testing 120.0.6099.109, 133.0.6943.141, and 152.0.7977.82.
A fourth lane resolves Google's latest stable Chrome build on each CI run;
the main job also covers the repository's Playwright Chromium. This checks
the minimum, the reported affected version, the school's newer version, and
forward compatibility as stable Chrome advances. It cannot guarantee an
untested future release. Historical 2.8.x upgrade fixtures
and all red-on-old proofs remain in that default job: their old storage
prerequisites and newer debugger-based upgrade mechanism are not valid on
Chrome 120. Compatibility jobs explicitly report those four historical
exclusions and instead test a native same-ID 2.9.4-to-candidate reload.
All current-candidate startup and recovery scenarios remain included on every
browser. Tests cover native IndexedDB,
migration, browser and worker restarts, privacy isolation, pending and failed
storage, retry ownership, diagnostics, and existing server authority races.
The immutable 2.9.4 fixture is commit
`c1cc0022334aefafc96764b5aaaa7f6fc15a8426`; new regressions must fail there on
their declared assertion, while original 2.9.3 regressions remain in the gate.

Validation results are recorded in the PR after execution. Automated desktop
Chromium cannot reproduce enterprise-managed ChromeOS policy injection; test
a fresh managed session and same-extension-ID upgrade on the affected
Chromebook before rollout. This PR prepares 2.9.5, preserving the existing
v2.9.4 tag and archive. Any local package generated during verification is a
test candidate. Produce the upload artifact from the final clean, reviewed,
tagged commit, check the live Store version immediately before upload, and
record its SHA-256. Merge, production deployment, and Store submission remain
separate release actions.

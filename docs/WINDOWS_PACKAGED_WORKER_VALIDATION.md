# Windows packaged browser worker validation

## Evidence boundary

On October 29, 2026, the complete `npm run test:extension:windows` suite passed on Node 24.19.0: 13 channel tests, complete package inventories, and 18 packaged-worker scenarios each in actual headless Chrome 156.0.8078.49 and Edge 156.0.4314.50. Each browser used a new disposable profile. The worker, content scripts, extension messaging, tab APIs, dynamic browser rules and HTTP client were real. The school server and native-messaging host were synthetic fixtures. No production source handlers were replaced. The fixture changes configuration/host transport only, plus content-free heartbeat diagnostics.

This is browser integration evidence, not a signed native-host, managed-policy or production-server acceptance result. The final development artifact was `windows-development-1793251679448`, version `3.0.3.1`, source revision `335123c8ff407446c5618e17a0c96ca94c82d157` with uncommitted changes and manifest source digest `75b49c3c8006a82b9b6a34533aed25a1ddd18f1344797964562d8ab3c532db48`. Both browsers reported zero worker console errors in the passing run. Simulated host invalidation completed local auth clearing in 19 ms (Chrome) and 47 ms (Edge); those values do not measure a physical OS event or a real signed host.

## Verified in both packaged browsers

| Behavior | Evidence |
|---|---|
| Native proof pairing and telemetry | Full worker adopts Windows identity, sends exact-source heartbeat and stores no browser credential in local storage. |
| Open, activate and close an exact tab | Commands arrive in HTTP heartbeat frames; actual tab state changes; full binding and control revision accompany HTTP ACKs, with per-ACK receipts. |
| Attention | Actual content-script overlay appears and clears. |
| Screen Lock | Canonical state installs actual browser DNR restrictions; state is then cleared. |
| Focus and Stop Focus | Opaque exact tab target reaches native active Focus, then clears. |
| Flight Path and block list | Allowed documents commit; denied documents produce native `ERR_BLOCKED_BY_CLIENT` and never reach the local TLS fixture. |
| Precise resource restrictions | Exact Google Doc, YouTube video and path-section destinations commit; wrong document/video and a sibling path are denied before reaching the fixture. |
| SSO pass-through | Synthetic Clever portal, configured Google dependency and approved lesson navigation work; lookalike provider hosts and unapproved apps remain denied. This is not real provider authentication. |
| Tab-limit overflow | Creating five extra tabs under a two-tab limit results in actual browser tab closure. |
| Hand raising | Extension runtime messages produce raise/lower actions on the Windows HTTP route, with source and control revision. |
| Classroom tools | Help request/withdraw, question parking and lesson progress pass through extension messaging and source-qualified Windows HTTP actions. |
| Poll | Multiple-choice delivery, response and close use the real worker and poll action route. |
| Timer | Timer command start/stop renders and clears the content overlay. |
| Teacher announcement | Modal content is visible and the durable command receives its HTTP ACK receipt. |
| Private chat | Complete server lifecycle metadata is negotiated; a teacher reply renders; a student reply carries its lifecycle and gets a matching delivered/client-message receipt. |
| Wrong student session | A stale command neither changes tabs nor sends an ACK under the current student's credential. |
| Host disconnect and reconnect | Simulated native-port loss synchronously retires auth; explicit reconnect obtains a fresh source. |
| Worker stop and wake | CDP stops the actual service worker; the restarted global lacks its previous incarnation marker, re-pairs with a new source and has no locally persisted browser token. The fixture explicitly restores its loopback school origin after managed startup selects the ordinary production default. |
| Full browser process restart | The owned browser PID changes; reloading the unchanged development artifact through CDP retains its opaque profile UUID and re-pairs a fresh source. Branded browsers do not automatically retain the session-scoped CDP development installation, so this does not establish managed-install auto-loading. |

The expanded matrix reports 18 scenarios per browser. Navigation tests reuse the shared portal fixture's local TLS CONNECT-proxy approach: all HTTPS destinations terminate in the fixture, denied requests are checked against its document log, and its untrusted one-day certificate is accepted only in the disposable browser launch. No certificate is installed. The original smoke assertions also check explicit clear before re-pair, unauthorized-host invalidation, session credential clearing and absence of Windows credential requests to legacy API routes. The separate channel suite covers bounded response bodies, cancellation, expired authority, origin changes and late work. The resource branch does not invoke this parity helper; resource results are recorded separately.

The real-server parity preparation separately discovered that help withdrawal was being routed as a new help request. The bridge correction distinguishes the DELETE operation. The synthetic helper requires a new, exact `class-tools:help-withdraw` request; an earlier help-request observation cannot satisfy that assertion. The complete suite above passed with the corrected artifact. The real server's help-row removal check is separate integration evidence. Relative to resource artifact `windows-development-1793250164988`, the only changed product file in each browser is `windows-worker-bridge.js`, containing that action mapping correction; all other product file hashes match.

## Mandatory remaining acceptance

These tests must not be used to claim that every enabled feature has completed end-to-end acceptance:

- Review the actual enabled server capability profile against the Windows capability filter. An enabled capability without a Windows route is a functional gap; a historical or disabled capability is not evidence that it is enabled.
- Test revisioned timer/activity snapshot rendering, short-text exit tickets, scheduled/supervision ownership changes, private-chat pause/end/reopen races and teacher-requested signout against the real server. The shared extension suites cover many corresponding lifecycle branches, but this new packaged-worker run does not reproduce all of them.
- Test the remaining restriction/navigation combinations, real SSO-provider authentication and browser/API refusal paths on managed browser versions. The basic local SSO, precise-resource, denial and tab-overflow paths above are already exercised in both packaged browsers.
- Validate browser screenshot grants, cadence, decoding and teacher reads against the real server; the resource fixture's capture/discard path alone does not establish teacher viewing.
- Verify the exact signed native host and Guard with Chrome/Edge, per-profile exclusivity, one-PIN pairing, UI close/crash continuity, guard crash, automatic extension loading after browser restart, managed installation/update/rollback and policy enforcement. No mock-host or CDP-reloaded development-package result substitutes for that evidence.
- Verify supported physical lock/sleep/user-switch transitions on suitable hardware. This host remains unlocked and does not sleep; simulated signals and service-worker termination do not establish those OS outcomes.
- Verify approved Store identities, extension adoption, forced policy/account restrictions and organization application control. This run does not apply registry or management policies and cannot establish coverage of portable or unapproved browsers.

## Run

Generate a fresh development package with `node scripts/package-windows-extension.mjs --development`, then run `node scripts/test-windows-workers.mjs --artifact=<generated-directory>`. The default Windows test runner invokes this non-resource path. Use the separately documented resource mode for duration/CPU/memory/capture evidence. Neither command installs a signed native host or applies managed policies.

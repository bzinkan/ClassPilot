# Shared Chromebook login recovery implementation plan

**Goal:** Repair reproducible ClassPilot 3.0.6 shared-login recovery failures that can leave the sign-in frame cycling or stuck after a successful server login.

**Architecture:** Keep server issuance and the existing exact-bound authentication transaction. Status recovery reads current worker state without replaying credentials. Cleanup of an expired prior identity must not invalidate a deliberate replacement login.

**Tech stack:** Manifest V3 JavaScript, trusted Chrome session storage, extension-origin IndexedDB, Playwright/native Chromium, Vitest; Node 24 or newer.

**Incident limitation:** The affected Chromebook is not identified. Reproducing a code defect does not establish that it caused the reported November 16 incident.

## Constraints

- Preserve policy, nonce, revision, authentication-generation and exact-binding checks.
- Keep student credentials and identifiers out of host pages, logs and durable local storage.
- Never automatically resubmit a PIN or email/ID login request to recover an uncertain response.
- Do not publish, replace a reviewed release archive, change Store version, or deploy SchoolPilot as part of this source repair.
- Use the isolated `codex/shared-chromebook-login-recovery` worktree based on `d185a7511f6c63f2829a6609520ebeae9aeb70b7`.

## Task 1: Resume interrupted login confirmation

**Files:** `extension/auth-gate-frame.js`, `scripts/test-extension-auth-recovery-frame.mjs`.

- [x] Add a native-frame regression: submit once, receive a newer unavailable state during submission, miss the completion push, then make read-only worker state authenticated.
- [x] Observe failure against unchanged 3.0.6: the frame never resumes current-state confirmation.
- [x] Keep bounded automatic read-only recovery running while the outcome is uncertain.
- [x] Verify recovery, one credential submission, and rejection of late obsolete callbacks/state.

## Task 2: Fence expired-identity checks during a replacement login

**Files:** `extension/service-worker.js`, `scripts/test-extension-shared-login.mjs`, package verification/script wiring if a new regression is needed.

- [x] Reproduce an expired manual identity being checked by `get-auth-state` while a deliberate replacement login is in flight.
- [x] Confirm the old expiry check cannot clear or supersede the replacement transaction. Change worker code only if this fails.
- [x] Cover ordinary expired-identity cleanup, current-generation pending login and real replacement-login completion.
- [x] Preserve explicit sign-out, policy-change and exact old-response cancellation behavior.

## Review focus

- A missed notification must recover from fresh worker authority without replaying credentials.
- Late prior-login responses and policy changes must never release the gate for a replacement context.
- Pending login must remain protected; skipping old-identity cleanup must not publish stale credentials.
- An ordinary expired manual session must still clear when no replacement login owns the transaction.
- Native pending operations must retain ownership; no timeout may authorize conflicting storage work.

## Task 3: Bound the single login network request through its response body

**Files:** `extension/service-worker.js`, `scripts/test-extension-login-response.mjs`, source/package script wiring.

- [x] Reproduce a real HTTP 200 whose JSON stream never finishes; confirm it parks the login and the next authentication mutation on unchanged 3.0.6.
- [x] Apply the existing five-second auth-request deadline to both login headers and body using an abort signal, retaining one credential submission and current 429 bookkeeping.
- [x] Verify stalled headers/body abort, release the transaction, retain protected sign-in, and allow a later deliberate credential submission to finish.
- [x] Preserve the separately authorized, exact-conflict-only managed-continuity fallback.

## Verification and handoff

- [x] Run targeted regressions with Node 24 and actual Chromium.
- [x] Run `npm run check`, `npm test`, `npm run build`, and `npm run test:extension:chrome`.
- [x] Run `git diff --check` and obtain independent code review; resolve substantive findings.
- [x] Record reproduced failures, fresh results and remaining managed-Chromebook acceptance/release boundaries in the repair document.

# CLAUDE.md

Guidance for all coding agents working in this repository. Keep instructions
aligned with executable scripts and reviewed protocol documents. Review baseline:
October 30, 2026, main `1c0e796`.

## Repository and production boundaries

ClassPilot's maintained deliverable is the Manifest V3 browser extension in
`extension/`. The Chromebook package and generated Windows Chrome/Edge packages
have separate identities and release evidence.

The sibling [SchoolPilot repository](https://github.com/bzinkan/SchoolPilot)
owns the production API and teacher web app. Read that repository's `CLAUDE.md`
before changing its handlers, schemas, frontend or deployment. The `client/`,
`server/`, `shared/` and `migrations/` directories here retain the prototype and
test infrastructure; changes here do not update the serving SchoolPilot API/UI.
`DEPLOYMENT.md`, `QUICK_START.md`, `AWS_DEPLOYMENT.md`,
`FARGATE_MIGRATION_SUMMARY.md` and `replit.md` contain historical prototype
instructions. Do not use them to deploy production or infer current credentials,
authorization, enabled features or release status.

Check `git status`, branch, worktrees and recent main history before editing.
Other sessions may own existing checkouts; use a separate worktree when needed
and preserve unrelated edits. Never replace a newer reviewed baseline with an
older local feature branch just because it contains a familiar release ZIP.

## Source map

| Path | Responsibility |
| --- | --- |
| `extension/service-worker.js` | Registration, authentication generations, settings, commands, network policy, screenshot capture/uploads and capture authority |
| `extension/offscreen.js` | WebSocket transport proxy, WebRTC media and leased active-preview tick scheduling |
| `extension/content.js` | Student overlays and classroom interactions |
| `extension/content-injection.js` | Worker-only content injection and owned-page reload orchestration |
| `extension/page-lifecycle.js` | Page-instance ownership and version handoff |
| `extension/auth-gate-*` | Isolated sign-in frame, transport and bootstrap |
| `extension/private-recovery-store.js` | Extension-origin IndexedDB recovery capability storage |
| `extension/classroom-runtime-core.js`, `poll-replay-core.js`, `school-website-policy.js` | Shared authority, poll replay and website policy logic |
| `extension/windows-browser-channel.js`, `windows-worker-bridge.js` | Guard-bound Windows browser transport and shared-worker integration |
| `extension/manifest.json`, `managed_schema.json` | Chromebook permissions, version and managed policy schema |
| `scripts/test-extension-*.mjs`, `server/__tests__/` | Native-browser harnesses and Vitest regressions |
| `docs/CLASS_PILOT_*_CANDIDATE.md`, `docs/release-evidence/` | Version-specific candidate evidence; historical records stay historical |

## Development and verification

Use Node **24 or newer** and npm **10 or newer**, as declared in `package.json`.
Install with `npm ci`; browser harnesses also need
`npx playwright install chromium` (`--with-deps` on Linux CI).

```sh
npm run check                       # TypeScript check, including retained prototype
npm test                            # Vitest: server/__tests__/**/*.test.ts
npm run build                       # Vite frontend + bundled prototype server
npm run test:extension:chrome        # Source behavior, recovery and red-on-old gates
bash extension/package-extension.sh # Versioned Chromebook ZIP + inventory check
npm run test:extension:package       # Exact ZIP inventory and packaged behavior
```

Choose targeted existing regressions during iteration, then run the relevant
aggregate gates for extension behavior/release changes. Useful focused scripts
include `test:extension:policy`, `test:extension:connection`,
`test:extension:poll-replay` and `test:extension:recovery` in `package.json`.
`npm run build` builds the retained prototype; extension packaging is separate.
The `dev`/`start` scripts use POSIX environment-assignment syntax; run them in
Git Bash/WSL or set the equivalent environment explicitly in PowerShell.
Do not point prototype tests or `db:push` at production.

`.github/workflows/ci.yml` runs the default Linux type/unit/browser/build/package
gates, Windows channel unit tests, a separate Windows packaged-browser job and
Chrome compatibility lanes. The compatibility matrix pins Chrome
120.0.6099.109, 133.0.6943.141 and 152.0.7977.82 plus resolved stable. Its
`CLASSPILOT_COMPATIBILITY_RUN=1` mode has deliberate historical-fixture
exclusions; the default lane retains the upgrade and red-on-old proofs. Do not
drop those checks to make a compatibility lane pass. `CLASSPILOT_CHROME_PATH`
selects a browser; `CLASSPILOT_EXTENSION_PATH` selects a harness artifact. Report
which source/archive and browser were exercised. Passing local tests do not
establish managed ChromeOS or signed Windows installation behavior.

Some Vitest release assertions inspect extension source text. Update guarded
assertions when behavior changes; do not weaken them to conceal a regression.

## Authority, identity and privacy

SchoolPilot decides capability rollout and authorization. Advertising a
capability is not authorization to enable it for a school. Preserve additive
compatibility for clients that cannot negotiate a feature and do not advertise
an unsupported Windows path.

Read [SCHEDULED_CLASSROOM_PROTOCOL.md](./SCHEDULED_CLASSROOM_PROTOCOL.md) for the
typed authority contract, then verify current details against SchoolPilot's
implementation. Each action retains its original `teachingSessionId` or
`supervisionContextId`; never put one into the other's field. Commands, student
actions, overlays and acknowledgements stay bound to the exact current student,
session, school/server, authentication generation, context/control revision and
deadline. Recheck authority after asynchronous work. Delayed callbacks, durable
replays and cleanup from a prior login must not act as a replacement student or
classroom. Command authority metadata does not itself install a restriction.

Production teacher actions use SchoolPilot's server-enforced student/context
command contract. Device IDs are internal transport identifiers; do not expose
them in teacher API/UI flows or use them to assign students through Rosters.
Missing or unavailable targets never imply a class-wide or school-wide action.

Read [docs/STARTUP_STORAGE_RECOVERY.md](./docs/STARTUP_STORAGE_RECOVERY.md) before
changing authentication or recovery storage. Active Chromebook credentials and
student identity belong in trusted `chrome.storage.session`; opaque durable
recovery capabilities belong in extension-origin IndexedDB. Local storage access
restriction is best effort on older supported Chrome, not a startup prerequisite.
Preserve migration markers/tombstones, transaction ownership and authentication
generation fencing. Missing/unavailable private storage requires protected fresh
sign-in; stale local data must not restore authority. Sign-in rosters, tokens,
device/session identifiers and raw storage errors must not leak into host pages
or diagnostics.

Capture requires the negotiated current monitoring policy and exact authority.
Keep full monitoring, limited after-hours safety and off modes distinct. Pixels
are not persisted by the extension; active-view cadence requires its bounded
lease and falls back when it expires. Do not revive retired Live View UI based
on historical prototype documentation or treat browser simulation as evidence of
silent managed-device capture.

Precise restrictions must remain precise on install, restore and downgrade.
Read [docs/PRECISE_RESTRICTIONS_ACCEPTANCE.md](./docs/PRECISE_RESTRICTIONS_ACCEPTANCE.md)
before changing matchers, DNR rules, storage schemas or rollback. A failed native
rule install retains the prior valid state and reports failure; it must not widen
a resource restriction into whole-host permission. Preserve authentication/SSO
provenance, rule budgets and exact-tab identity checks.

Keep credentials, private keys, school rosters, browsing content and production
captures out of commits and logs. `extension/config.js`, `.env*`, `dist/` and
`artifacts/` are ignored local outputs; ignored status alone is not a security
review. The Chromebook packager excludes local configuration.

## Chromebook version and release contract

The reviewed source prepares **3.0.3**, with Chrome **120** as its minimum.
This is a source observation, not a claim about the live Store or installed fleet.
The root application package version is independent. When preparing a successor,
update all extension version guards together:

| File | Version guard |
| --- | --- |
| `extension/manifest.json` | `version` |
| `server/__tests__/extension-release.test.ts` | Expected manifest version |
| `scripts/verify-extension-package.mjs` | `expectedPreparedReleaseVersion` |

Update the corresponding candidate record and `extension/README.md`. Existing
root `CLASSPILOT_*_RELEASE.md` notes and older candidate records are dated
evidence, not current release instructions.

Package from the repository root with `bash extension/package-extension.sh`.
It emits `dist/ClassPilot-v<version>.zip`, its `.sha256` record and an unversioned
compatibility copy. Preserve older versioned archives. The verifier checks names,
manifest, complete allowed file inventory and source bytes; the full package gate
also runs the packaged behavior suites. `--verify-only` checks package integrity
without those behavior suites and is not a substitute for the full gate.

For an authorized release, use the exact ZIP from the final clean, reviewed,
tagged source and retain its SHA-256, source revision and validation evidence.
Do not hand-build or silently replace an archive already reviewed/uploaded.
Store upload/publication is separate from preparation, merge, API/web deployment
and fleet adoption. Immediately before uploading, confirm the live version and
pending submissions in the authenticated Developer Dashboard for extension
`iggbfegfcjkfieoemeolfmfnapepalca`; an uploaded version cannot be reused. Follow
[docs/CLASS_PILOT_3_0_3_CANDIDATE.md](./docs/CLASS_PILOT_3_0_3_CANDIDATE.md), or the
reviewed successor record, for exact release scope and outstanding acceptance.

## Windows Chrome and Edge variants

Read [docs/WINDOWS_BROWSER_RELEASE.md](./docs/WINDOWS_BROWSER_RELEASE.md) and
[docs/WINDOWS_PACKAGED_WORKER_VALIDATION.md](./docs/WINDOWS_PACKAGED_WORKER_VALIDATION.md).
The sibling ClassPilotDesktop repository owns the signed app/Guard/native host;
SchoolPilot owns server routes, tenant isolation and separate default-off Windows
and Desktop visibility gates. Preserve that separation when coordinating changes.

```sh
npm run test:extension:windows:unit # Channel unit tests
npm run package:extension:windows  # Development Chrome/Edge artifacts only
npm run test:extension:windows     # Channel + package + actual packaged workers
```

Development output goes under ignored `artifacts/windows-development-*`, with
per-browser hashes and `package-manifest.json`. Windows uses separate Chrome and
Edge public keys/Store identities and an independently versioned four-part
candidate (currently `3.0.3.1`), without rewriting the Chromebook manifest.
Release packaging uses `scripts/package-windows-extension.mjs` with separately
approved `--public-keys=<file>` and `--version=<version>`; it rejects dirty source.
Fixture public keys are development identities, never approved Store identities.

The browser receives one-use native proofs and a memory/session-only browser
bearer scoped to its paired HTTPS origin and opaque source/revision. It must
never receive the installation credential, Guard bearer or PIN, and must not
send browser credentials through legacy Chromebook routes. Native-host failure
retires authority immediately; stale completions cannot authorize a new student.
Keep unsupported capabilities filtered in the Windows bridge.

Both development and candidate package manifests set `pilotReady: false`.
Disposable-browser/simulated-host tests do not prove signed native-host behavior,
managed installation, physical lock/sleep/user switching, Store adoption or
complete browser coverage. The documented signed-host, enabled-capability,
managed-device, lifecycle and rollout gates remain separate release evidence.

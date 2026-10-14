# CLAUDE.md

Guidance for Claude Code when working in this repository. It consolidates the
"the real runbook is SchoolPilot's `CLAUDE.md`" headers that `DEPLOYMENT.md`,
`QUICK_START.md` and `replit.md` each carry, so an agent has one place to read
first. The extension specialist session owns this file; keep it short and keep
it true.

## What this repository is

- **Deliverable:** the ClassPilot Chrome extension in `extension/` (Manifest V3,
  service worker plus offscreen document). Chrome Web Store id
  `iggbfegfcjkfieoemeolfmfnapepalca`.
- **Production API and web app live in the sibling SchoolPilot repository**
  (`C:\GitHub\SchoolPilot`). Its `CLAUDE.md` is the production runbook. Nothing
  in this repository deploys a server; `DEPLOYMENT.md`, `QUICK_START.md`,
  `AWS_DEPLOYMENT.md`, `FARGATE_MIGRATION_SUMMARY.md` and `replit.md` describe
  the retired prototype and are historical.
- **Wire contract:** `SCHEDULED_CLASSROOM_PROTOCOL.md` is the de-facto
  specification for how the extension negotiates capabilities with SchoolPilot
  (`scheduledClassroomV1` together with `scopedAuthorityChecksV1`, one original
  authority per action). Capability reach is decided by SchoolPilot's rollout
  registry, never by the extension: the extension advertises every capability it
  supports and the server decides per school.
- **Release notes** live at the root as `CLASSPILOT_<version>_RELEASE.md`; the
  newest one describes the current candidate and what it does and does not
  authorize.

## Version pinning (bump all three together)

| File | What it pins |
|---|---|
| `extension/manifest.json` (`"version"`) | the extension version itself |
| `server/__tests__/extension-release.test.ts` (`expect(manifest.version).toBe(...)`) | the release test's expected version |
| `scripts/verify-extension-package.mjs` (`expectedPreparedReleaseVersion`) | the version the package verifier expects to find |

A mismatch fails CI. The packaged artifact is always
`dist/ClassPilot-v<version>.zip`, produced only by the repository packaging
script from a clean, reviewed, tagged release commit.

## Tests and CI

`.github/workflows/ci.yml` runs, in order: `npm ci`, `npm run check`,
`npm run test` (vitest; `server/__tests__/*` load extension modules through
`node:vm`), `npm run test:extension:chrome` (the Chrome harness lane:
resilience, authority races, scheduled classroom, 2.7 behaviour, offscreen and
popup identity, auth layout and startup, portal-first, the recovery lane, and
red-on-old), `npm run build`, then `npm run test:extension:package`.

- `extension-release.test.ts` asserts on **source text** of the extension;
  do not rename guarded literals without updating it.
- Known flake: `scripts/test-extension-resilience.mjs`
  `managedDeviceContinuityFlow.requestOrder` can see an extra trailing
  `preflight` under load. Re-run once before investigating.

## Publishing gate

Publishing to the Chrome Web Store is a separate, explicitly authorized step.
It is never implied by a merge, a green CI run, a tag, or a packaged zip.
Before any upload, recheck the live Store version; installed Chromebook
versions and Store publication are separate evidence. Read the newest
`CLASSPILOT_<version>_RELEASE.md` for what the current candidate authorizes.
Do not publish while a school is in a testing window.

## Working agreements

- Another Claude session may be active in this repository. Do not switch the
  branch of the main checkout at `C:\GitHub\ClassPilot`; use a worktree.
- Keep backend, frontend and extension compatibility additive during a rollout:
  a device that cannot negotiate a capability must keep its existing behaviour.
- Never claim silent Live View: `chrome.tabCapture` needs an activeTab grant
  the extension's action cannot produce, so the student always sees a picker.

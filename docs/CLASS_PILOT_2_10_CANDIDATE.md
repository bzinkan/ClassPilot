# ClassPilot 2.10.0 local release candidate

The exact local candidate at `b187af42d97f63eff31da9a1c9cf7535f853bb6f`
passed Node 24.19.0 type checking, 199 unit tests, the complete source browser
suite and the exact packaged-extension verifier on September 30, 2026 local
time (completed October 1 UTC). Twenty immutable old-release regressions failed
as expected; the source browser suite had already exercised the current code.
The package verifier checked all 24 files byte for byte and reran native
enforcement, lifecycle, private-vault and managed-mode browser simulations.

Candidate: `dist/ClassPilot-v2.10.0.zip`, 363,097 bytes.
SHA-256: `84808cfc8b900d0fe29f2e682f4211c84510bff72afcf3e969b4b8794c94557e`.
The existing ZIP was preserved through fixture-only rebases. The documentation
commit that adds this record changes no extension or verification-script bytes.
Structured results, exact commands, log hashes and pending gates are in
[the evidence record](release-evidence/classpilot-2.10.0-candidate-20260930.json).
The four named logs are retained in the operator's local temporary directory;
copy them with the tested ZIP into a durable release-evidence destination before
any later authorized publication. A rebuild may change ZIP metadata/hash and
creates a new artifact that needs exact-package and managed-device validation.

Current-head CI is recorded separately in draft PR #121. A green prerequisite
head does not cover an amended head. Local Chrome/151.0.7922.34 managed-mode
fixtures are simulations and do not satisfy the two managed Chromebook gate.
Capability negotiation and the reviewed SchoolPilot contracts remain required;
all new server capabilities and modes remain default off.

## Managed-device record to complete before publication

Use this exact ZIP on two Google Admin-managed Chromebooks. For each record,
capture ChromeOS/browser version, managed profile and policy state, school test
context, commit, version, ZIP hash, test date, operator, result and sanitized
failure evidence. Do not include real student names, device IDs or credentials
in public evidence. Test both devices for:

- Fresh sign-in, shared-device student changes, sign-out and private recovery.
- Exact resources/sections, provider authentication, SPA navigation, reload,
  back/forward, school/teacher policy precedence and failed policy installation.
- Worker sleep/wake, offline/reconnect and mixed server/extension capabilities.
- Duplicate URLs, stale references, tab disappearance/replacement and unsafe
  navigation; Focus survives ordinary snapshots and respects Attention/auth.
- Bring Forward, Open + Focus from the acknowledged exact tab, Stop Focus with
  the new gate off, expiry and authority/entitlement loss without clearing other
  classroom restrictions.
- Classroom lesson application failures, partial student outcomes and opening
  only after confirmed restriction application.

Leave managed validation unbound until both actual device records pass. No
managed-device pass, production deployment, activation or Store upload is
claimed here. Exact approved America/New_York freeze boundaries are still
unavailable; this evidence authorizes no operational work.

## Later authorized operator steps

Reverify the official Store listing and release history immediately before an
upload. The September 30 observation was 2.9.6, updated September 27; the
v2.9.6 source tag resolves to `55bb531`, and GitHub Releases was empty. Those
observations do not identify the live Store ZIP hash. Confirm the successor is
still available before any upload, and retain the selected artifact's hash.

Reconcile live API/worker RLS admission and serving image compatibility before
preparing new governed activation plans. Serving and rollback images must
support persisted precise resources. Rollback order is disable, clear
incompatible state through the service-bound procedure, then compatible image
rollback. Stop Focus remains available for cleanup and clears only Focus.
SchoolPilot API/web deployment does not release the extension. Merges,
deployment, activation and Store publication require their separate authorized
workstreams.

# Precise restriction candidate evidence

This source slice implements SchoolPilot's finalized #555/#559 precise resource
contract. The byte-identical shared fixture has SHA-256
`4ff6b3311bcf6937a776deb5c5eec60de98d7d74e9dc963bf762a842b440d243`.
The combined unpublished successor is now 2.9.7; its source and exact-package
results are recorded separately in [the current candidate record](CLASS_PILOT_2_9_7_CANDIDATE.md).
The earlier `release-evidence/classpilot-2.10.0-candidate-20260930.json` remains
immutable historical evidence and does not cover the new extension bytes.
Neither record identifies the published Store package. Publication is outside
this implementation workstream.

## Enforcement and compatibility

Resource-only Flight Paths and resource/Section Waypoints use strict whole-state
validation. One matcher drives navigation, tab creation, reconciliation and
restriction destinations. School and teacher blocks retain their priority over
resources; temporary allows cannot become resource exceptions. Attention covers
the page while independent DNR, precise and authentication policies remain active.
Only negotiated, exact-bound delivery can install new precise policy.

Main-frame DNR rules are built before mutation, checked against the classroom
range and the conservative 800-regex total budget, then validated using native
Chrome `isRegexSupported`. Native updates remain atomic. Chrome's compiled RE2
memory limit rejects some otherwise valid rich expressions. Those use a
strictly narrower supported shape: canonical YouTube watch links with bounded
common parameters or short links, and canonical document/Form/file landing URLs
with query/fragment suffixes. Encoded path tails and additional provider aliases
may be blocked by that fallback. A different video/document, whole provider
website or unsupported authentication exception is never substituted. If even
the narrow shape cannot install, the prior valid policy, expiry, persisted state
and rules survive and adoption is acknowledged failed.

Precise persistence uses storage-only schema2 with a version1 marker. Wire
schema remains1. The current worker decodes and validates the exact restriction
while preserving SSO provenance for the existing trusted-restore validator.
The immutable tagged2.9.5 and2.9.6 runtimes reject schema2; an old worker therefore
cannot silently restore a document restriction as a whole-host Waypoint.
Sign-out/new-student cleanup clears resources and their persisted rules.

## Local checks

Node24 type check and all195 unit tests pass. Native Chrome acceptance checks
94 shared matcher cases across9 valid resources, actual supported DNR patterns,
atomic installation failure, honest ACKs, capability withdrawal/owned restore,
and three rapid forbidden pushState/replaceState redirects without a cooldown.
Synthetic pages and DNS/transport isolation prevent school or external API load.
Released-source downgrade/corrupt-storage tests pass. The source and unpacked
package test chains both include these checks. Full source Chrome/red-on-old
and CI gates are recorded separately at the final revision.

## Release gates

The official Store listing was rechecked on September 30, 2026 and shows 2.9.6,
updated September 27. This supersedes the earlier observed 2.9.5 listing. The
remote v2.9.6 tag resolves to `55bb531cb5f130cebec9d994daa957e82e87a13b`;
the immutable source fixture is reproducible with archive SHA-256
`c7a6c31c8e2fbe4e7264a0f62d559af5ebb78f52326d203a7ac79038fd87e696`.
GitHub Releases is empty; remote tags extend through v2.9.6, with no 2.10.0 tag.
These are dated source/listing observations, not proof of the Store ZIP hash.
The Store must be verified again immediately before any authorized later upload.
[Official listing](https://chromewebstore.google.com/detail/classpilot/iggbfegfcjkfieoemeolfmfnapepalca).

Focus is a separate dependent source slice. Package precise enforcement and
Focus together only after both source and exact-package checks pass. For the
2.9.7 release the user expressly waived the two managed Chromebook pre-release
gate and chose exact-package live production acceptance after their greenlight.
Record installed version/capabilities and actual live results; local Chrome
simulations remain distinct from managed production evidence. Capabilities
remain default off on the server. Deployment, activation, Store upload and
incompatible-state clearing/rollback require their separate workstreams.

# Precise restriction candidate evidence

This source slice implements SchoolPilot's finalized #555/#559 precise resource
contract. The byte-identical shared fixture has SHA-256
`4ff6b3311bcf6937a776deb5c5eec60de98d7d74e9dc963bf762a842b440d243`.
The repository's existing 2.9.6 version is an unsubmitted prepared candidate,
not evidence of the live Chrome Web Store version. Select a successor version
only after checking the live listing and release history. Publication is outside
this implementation workstream.

## Enforcement and compatibility

Resource-only Flight Paths and resource/Section Waypoints use strict whole-state
validation. One matcher drives navigation, tab creation, reconciliation and
restriction destinations. School and teacher blocks and Attention retain their
priority over resources; temporary allows cannot become resource exceptions.
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
The immutable released2.9.5 runtime rejects schema2; an old worker therefore
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

Focus is a separate dependent source slice. Package precise enforcement and
Focus together only after both source and exact-package checks pass. Record
commit, selected version, ZIP SHA-256 and results on two managed Chromebooks.
No local Chrome simulation satisfies that managed-device gate. Capabilities
remain default off on the server. Deployment, activation, Store upload and
incompatible-state clearing/rollback require their separate workstreams.

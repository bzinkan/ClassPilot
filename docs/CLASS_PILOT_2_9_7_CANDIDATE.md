# ClassPilot 2.9.7 local candidate

This unpublished candidate is stacked on reviewed PR #122 at
`2aa6df988a78cb5860cef2c0866cab46566ffec5`. It includes precise restrictions,
Focus and Bring Forward, lesson activity confirmations, the private chat fixes,
and the following release corrections:

- Attention covers documents without installing its former main-frame block,
  navigating back, removing tabs or replacing a page. Browser UI stays usable.
  School/teacher blocks, precise restrictions, tab limits and authentication
  boundaries remain enforced; Focus suspends and resumes on the exact saved tab.
- Titles and favicons are refreshed metadata. Native tab identity, order,
  opaque refs and URLs still change the snapshot revision; title-only updates
  do not invalidate an otherwise exact Focus/Bring Forward command.
- Announcements have a separate modal, native notification and popup history.
  Private chat switches, pause and End Chat do not disable announcements.
- `privateChatLifecycleV1` requires `scopedAuthorityChecksV1` and
  `studentChatIdempotencyV1`. Private frames, ACKs and queued student replies
  carry server-owned thread/epoch/generation tokens. End Chat retires `<G`;
  fresh G may reopen, while delayed close G cannot clear it. Hard-off retires
  the school epoch. Unknown ownership requests recovery without a delivered ACK.
  Established sessions fail closed after capability withdrawal or incomplete
  lifecycle recovery. Protected session storage retains bounded per-activity
  floors across worker wake; inactive threads cannot receive private delivery.
  Reclaiming the same activity may replace its thread only through a validated
  FAB with newer ownership revision. Private messages cannot introduce a new
  owner, and retired thread IDs cannot be restored by delayed FAB/messages.

The manifest is 2.9.7 with the existing extension identity and Chrome120 floor.
Wire protocol remains3; precise classroom wire schema remains1. The release
does not change historical matcher fixtures or released-source archives.

The immutable tested source is `065be165b5df704d84eb716e3fb914c1fed17f98`,
with production bytes from parent-reviewed runtime checkpoint `9aa02c0`.
Node24.19 typecheck and204 unit tests pass. The serialized full source chain,
42 recovery scenarios and20 expected historical-release rejection probes pass.
The exact frozen ZIP verifies24 files byte-for-byte and passes the full native
chain on Chrome151, including private-vault browser restart, fresh sign-in and
actual local managed-mode worker stop/wake for Focus and private chat.

The ZIP is `dist/ClassPilot-v2.9.7.zip`,376052 bytes, SHA-256
`82352b04020b5fefdee06aa46cc3ba963ddac0d6c7eab4e241fca2cf6ca61575`.
It was not rebuilt after verification. The
[new evidence record](release-evidence/classpilot-2.9.7-candidate-20261002.json)
pins logs, hashes,39 advertised capabilities and their exact raw/LF source
binding. The earlier concurrent scheduled-classroom and cold-paint failures
remain recorded; their contention/setup cause is unproven. The unchanged
serialized gates pass, with no production or deadline relaxation.

At the dated capture, all five required jobs in
[pull-request run37044469285](https://github.com/bzinkan/ClassPilot/actions/runs/37044469285)
passed, including full source/package lanes on Chrome120,133,152 and stable.
CI builds an archive per job; that matrix does not claim those ZIP bytes equal
the frozen local ZIP. Actual120 Attention/Focus/lifecycle and2.9.6 upgrade
probes, local133 full source and the exact local ZIP gate are separate evidence.
The redundant same-head push run37044463367 was deliberately canceled while
the required pull-request matrix was retained. This record covers tested065;
later documentation-only head outcomes belong in the PR body, avoiding a
self-referential evidence/CI commit loop. Backend release PR603 and final
release review/operational acceptance remain separate gates.

The native upgrade case installs the immutable released 2.9.6 source archive,
opens a page with its actual 2.9.6 content owners, then reloads the same native
extension identity with the candidate. Chrome120 and the local modern engine
take the existing protected manual ownership fallback: no automatic page
navigation is authorized, one explicit reload adopts only 2.9.7 owners, and
private storage and fresh sign-in remain intact. These source probes do not
prove a Store update or a managed Chromebook rollout. The same native case also
passes against the exact frozen ZIP on Chrome151, inspecting actual old and
current content owners.

## Historical evidence and operational boundaries

The prior unpublished 2.10.0 candidate document and JSON remain unchanged.
Their ZIP SHA-256 `84808cfc8b900d0fe29f2e682f4211c84510bff72afcf3e969b4b8794c94557e`
does not cover 2.9.7. A new exact ZIP/hash and byte-for-byte package verification
are required. The live Store was observed as 2.9.6 on October2; its published
binary hash/source binding remains unknown. Verify the listing/history again
immediately before any authorized upload.

The user explicitly waived the two managed Chromebook pre-release gate for
2.9.7 and chose live production acceptance after their greenlight. This waiver
changes the release gate; it does not claim actual managed-device validation.
Deployment, capability activation, Store upload and merges remain unauthorized
by this implementation task. A locally installed 2.10.0 build does not
automatically downgrade to2.9.7, and Store adoption is asynchronous.

Before expanding live activation, record the exact installed2.9.7 version and
negotiated capabilities in the intended managed student scope. Verify sign-in,
student switch/sign-out, precise authentication and page navigation, exact-tab
Focus/Stop cleanup, page-preserving Attention, End Chat/hard-off expiry, fresh
private reopening and independent announcements. Keep unsupported recipients
withheld and record sanitized failures. Disabling server capabilities prevents
new feature use but does not prove extension rollback or removal of installed
state; use documented exact-bound cleanup and a compatible serving/rollback
image. A Store rollback normally needs a higher version containing reviewed
compatible behavior. Preserve immutable historical and new artifact evidence.

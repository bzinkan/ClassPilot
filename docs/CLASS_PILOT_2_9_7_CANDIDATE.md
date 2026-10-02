# ClassPilot 2.9.7 candidate preparation

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

Source/check, full native browser matrix, exact final ZIP and independent review
results will be bound to the local immutable checkpoint in the new evidence
record after the final contract and gates settle. No complete matrix or package
pass is claimed by this preparation document.

The native upgrade case installs the immutable released 2.9.6 source archive,
opens a page with its actual 2.9.6 content owners, then reloads the same native
extension identity with the candidate. Chrome120 and the local modern engine
take the existing protected manual ownership fallback: no automatic page
navigation is authorized, one explicit reload adopts only 2.9.7 owners, and
private storage and fresh sign-in remain intact. These source probes do not
prove a Store update or a managed Chromebook rollout. The same case is part of
the exact-package gate, whose result remains pending until that gate completes.

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

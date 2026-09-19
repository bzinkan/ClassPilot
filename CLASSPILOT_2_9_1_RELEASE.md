# ClassPilot 2.9.1 class chat candidate

Version 2.9.1 carries 2.9.0 forward unchanged and adds the student side of the
class chat redesign: the teacher's soft pause, the server's send cooldown,
"seen" acknowledgements for teacher messages, and small polish in the chat box.
No Chrome permission, managed-policy key, endpoint or support code is added or
changed. Two capability names are added to the advertised list; the server only
narrows what it accepts.

The public Chrome Web Store listing `iggbfegfcjkfieoemeolfmfnapepalca` must be
rechecked immediately before any upload. Recheck the
live Store version immediately before any future upload; installed Chromebook
versions and Store publication are separate evidence.

This candidate update does not tag, package, upload, publish or activate the rollout.
The canonical future artifact is
`dist/ClassPilot-v2.9.1.zip`, produced only by the repository packaging script
from a clean, reviewed, tagged release commit during the authorized release.
`ClassPilot-v2.9.0.zip` and every earlier artifact, SHA-256 record and release
note remain retained and unchanged.

Publishing 2.9.1 is a separately authorized step. It stays blocked while NWEA
testing is in progress and until a managed Chromebook has been observed running
2.9.0 (see the 2.9.0 operator gate).

## Carried over unchanged from 2.9.0

Scheduled classroom support is unchanged. Deploy the compatible SchoolPilot
API/worker and additive `classpilot-scheduled-classroom-20260915` migration
before any rollout; the server-side rollout stays `CLASSPILOT_SCHEDULED_CLASSROOM_MODE=off`
until separately authorized. The `scheduledClassroomV1` and
`scopedAuthorityChecksV1` capabilities are negotiated exactly as in 2.9.0.
Live View remains backend-only and the teacher Live View UI stays disabled.
Startup recovery, the auth gate, sign-in flows, screenshots, heartbeats and
every managed-policy key are unchanged from 2.9.0.

## What changes in 2.9.1

**Pause rides the existing FAB frame.** `normalizeFabState` keeps two new keys,
`messagesPaused` and `pauseReason` (`teacher` or `testing`); they are persisted
with the FAB state, listed in the session-scoped storage keys and the UI state
answer, and cleared with the rest of the FAB state. The content script disables
the compose box while paused, shows "Paused by your teacher" or "Paused during
testing" above it, and refuses a send with the same copy. The worker refuses to
queue while paused (`STUDENT_CHAT_PAUSED`), and a server `403` with code
`chat_paused` or `CHAT_PAUSED` **drops** the outbox entry (it can never be
delivered) and adopts the pause at once. The popup mirrors the copy. The
thread-clear branches are untouched: a pause never erases the conversation.

**Cooldown never touches the shared lane.** Student sends move to their own
backoff lane (`backoffLane: 'chat'`), so a chat `429` cannot delay heartbeats,
acknowledgements or settings reads. A `429` puts the entry in a `waiting`
state with `holdUntil` taken from the server's `retryAfterMs` (clamped to
1–120 s), the flush loop skips it until then, and a sub-30 s hold also arms an
in-memory timer because packed-extension alarms floor at 30 s. The chat box
shows "Waiting" on the bubble and "Slow down! You can send again in Ns", and
applies a 2 s local send interval so the server limit is rarely reached.

**Seen.** When a teacher message is rendered in an open chat box on a visible
tab, the content script reports `chat-message-seen` once per message (also on
opening the box and on returning to the tab). The worker marks the inbox entry
`seenAckedAt` once across tabs and sends a `seen` delivery acknowledgement
through the existing durable ack outbox. `enqueueChatAck` accepts `seen`, and a
later `delivered` acknowledgement no longer evicts a `seen` one. Acknowledgement
receipts with `accepted: false` and a terminal code (`INVALID_CHAT_ACK`,
`CHAT_MESSAGE_NOT_FOUND`) now drain instead of retrying every 30 s for 24 hours;
a stale binding stays retryable. A server that predates the seen state rejects
the ack as invalid, which drains it, so 2.9.1 is safe against an older API.

**Polish.** Each bubble shows the sender and the time it was sent, the input is
capped at 500 characters with a counter from 400, and a `Waiting` status joins
`Sending`, `Retrying`, `Delivered` and `Failed`.

## Candidate verification

Require `npm run check`, `npm test`, `npm run build`, and
`npm run test:extension:chrome` on the exact candidate source. The Chrome gate
retains the scheduled classroom, startup recovery and same-extension-ID upgrade
checks, and gains the chat cases: a cooldown hold with an untouched general
backoff lane, a paused-class rejection that drops the entry and adopts the
pause, a refused send while paused, a `seen` acknowledgement that survives a
later `delivered`, and a terminal receipt that drains.

Release guards in `server/__tests__/extension-release.test.ts` pin the 2.9.0
permission lists, managed-policy schema keys, auth-gate screen wording, support
codes, the absence of any update-check, reload or beacon call in extension
sources, and now the chat lane, the pause codes and the terminal receipt codes.

When preparing the release package, require source/ZIP byte equality,
the versioned artifact and SHA-256 record, and `npm run test:extension:package`
against the unpacked ZIP, including scheduled classroom checks. Retain source
commit/tag and CI receipts; preserve prior versioned artifacts and release notes.
Never replace a prior versioned ZIP with different source bytes.

## Managed-Chromebook operator gate

**HARD STOP.** Submit with deferred publishing. Publish only after the 2.9.0
operator gate has been recorded on a managed Chromebook and NWEA testing is not
in progress, and after the SchoolPilot backend carrying the chat pause, seen and
read state (PRs #479, #480, #483, #484) is deployed. Then, on the exact reviewed
artifact: one managed Chromebook on an in-place 2.9.0-to-2.9.1 upgrade under the
same extension identity; send one message during a paused class and confirm the
banner, the refusal and that the thread survives; send five messages in quick
succession and confirm the "Waiting" state clears on its own; open a teacher
reply and confirm the dashboard shows `Seen` once. Record ChromeOS version,
installed extension version and test time without student identities. Recheck
the live Store version immediately before upload.

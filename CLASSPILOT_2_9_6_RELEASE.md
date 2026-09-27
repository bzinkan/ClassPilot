# ClassPilot 2.9.6 sign-in roster isolation candidate

Version 2.9.6 is an unsubmitted privacy correction. Grade rosters and sign-in
now reach students only through the sign-in frame, an extension page that the
web page underneath cannot read. There is no new Chrome permission,
managed-policy key, endpoint, or screen change. The sign-in frame, its wording
and its support codes are unchanged.

## What was found

The live sign-in UI has been the extension-owned sign-in frame for several
releases. 2.9.5 still carried the retired in-page sign-in form in the web-page
content script (`content.js`). The form itself was never shown, but its roster
refresh still ran whenever a signed-out page gained focus, became visible,
was restored or came back online. That refresh looked up the form's element IDs
in the page's own document and wrote the results into whatever it found.

A web page open behind the sign-in gate on a signed-out Chromebook at a
name-and-PIN school could therefore create elements with those IDs and read
back what the extension wrote: the grade list, then each grade's student names
and IDs, including "Resume on this Chromebook" and "PIN missing" markers. The
extension also kept refreshing those elements on a timer. Sign-in itself was
not exposed: the retired form's submit wiring was never attached.

This was found in code review and reproduced in the browser gate against the
immutable 2.9.5 sources. There is no evidence that any site used it.

## What 2.9.6 changes

- The retired in-page form is removed from `content.js`: its markup, roster and
  grade loading, refresh timers, retry wiring, sign-in submission and kiosk
  button handling (about 1,400 lines, none reachable from the live sign-in
  frame). Page focus, visibility and network events now only reconcile the
  existing sign-in presence signal.
- The service worker answers `get-login-roster`, `manual-student-login` and
  `request-kiosk-launch` only from extension pages, such as the sign-in frame.
  Requests from content scripts, which share a renderer with the web page, are
  refused. Other messages are unchanged.

## Verification gate

`npm run test:extension:red-on-old` includes the new `page-dom-roster-isolation`
case against the immutable v2.9.5 fixture (`scripts/fixtures/auth-recovery-2.9.5.json`).
On 2.9.5 it fails on its declared regression assertion: roster names reach a
page-owned decoy element. On the candidate it passes and also proves that a
content script is refused the roster, sign-in and kiosk launch while the real
sign-in frame still loads the roster and signs in. A worker unit test covers
accepted and refused senders.

Required checks: `npm run check`, `npm test`, `npm run build`,
`npm run test:extension:chrome` (including red-on-old), package byte comparison
and `npm run test:extension:package`, and `git diff --check`. Managed-device
acceptance remains a separate release gate: fresh sign-in on a signed-out
Chromebook and a same-ID upgrade from 2.9.5.

## Release handling

This candidate update does not tag, upload, publish or activate the rollout.
The canonical future artifact is `dist/ClassPilot-v2.9.6.zip`, produced only by
the repository packaging script from a clean, reviewed, tagged release commit
during the authorized release. `ClassPilot-v2.9.5.zip` and every earlier
artifact, SHA-256 record and release note remain retained and unchanged.
Recheck the live Store version immediately before any future upload. Submit
with deferred publishing only after managed acceptance and final review.

## Carried over unchanged from 2.9.5

Chrome 120+ private recovery storage, the 2.9.4 worker wake recovery, Class
tools, the class chat controls and the 2.9.0 startup recovery are unchanged.
Scheduled classroom support and its rollout requirements are unchanged, and
Live View remains backend-only with the teacher Live View UI disabled.

# Scheduled classroom authority

Scheduled testing and scheduled coverage can expose the same student classroom tools as a teaching session when SchoolPilot negotiates `scheduledClassroomV1` together with `scopedAuthorityChecksV1`. The server rollout remains authoritative. Ad hoc supervision and older clients keep their existing behavior.

Every action names exactly one original authority: `teachingSessionId` or `supervisionContextId`. A supervision ID is never placed in a teaching-session field. FAB snapshots retain teaching-only `activeSessionIds` for compatibility and add typed `activeContexts`. Scheduled snapshots identify `contextSource` as `scheduled_testing` or `scheduled_coverage` and may provide `contextName`.

Student chat, hands, poll responses, and durable teacher-message acknowledgements retain the original supervision context and `studentControlRevision`. Timer and poll restoration is scoped to that original context and the exact authenticated browser binding. Expiry and context changes clear overlays; delayed callbacks cannot send as a replacement classroom or student.

Screenshot leases can carry `{kind:'supervision_context', supervisionContextId, controlRevision}`. Capture and active-view cadence require current matching authority and stop at their lease or classroom boundary. Screenshot-policy refresh frames accept typed supervision authority without widening the lease.

Live View requests retain the exact student/browser binding, typed classroom authority, and supervision control revision. A signed server negotiation is bounded by the scheduled end. Context or ownership changes retire capture; stale negotiation callbacks cannot replace a newer stream. Server authorization is required for ICE configuration, signaling, and telemetry.

Run `npm run check`, `npm test`, `npm run build`, and `npm run test:extension:chrome`. The Chrome gate includes `scripts/test-extension-scheduled-classroom.mjs`, which exercises actual popup actions and a content-script poll, original-context persistence, scoped screenshot/Live View authority, legacy capability rejection, and handoff/expiry checks.

This implementation does not change the manifest version and is not a Chrome Web Store release. SchoolPilot API/web deployment does not distribute this extension. A separately authorized versioned extension release and live-version verification remain required before publishing.

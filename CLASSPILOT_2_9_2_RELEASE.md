# ClassPilot 2.9.2 Class tools release

The canonical Chrome Web Store upload is `dist/ClassPilot-v2.9.2.zip`, generated
by `extension/package-extension.sh`. Retain its `.sha256` and validation record.
Older versioned archives remain unchanged. Packaging is authorized; this task
does not upload, publish, or enable any school rollout.

## Included changes

The extension carries forward 2.9.1 messaging, pause controls, cooldowns,
read/seen acknowledgements, readiness, and recovery. It adds the student side of
Class tools: typed help and acknowledgement, private questions and answers,
pinned instructions/resources/checklists, explicit work status, short-text exit
tickets, and revisioned timer pause/resume/extension.

Five capabilities are negotiated separately: `helpRequestsV1`,
`questionParkingV1`, `timerControlsV1`, `lessonActivitiesV1`, and `exitTicketsV1`.
They require `scopedAuthorityChecksV1`; scheduled classrooms also require
`scheduledClassroomV1`. Unsupported clients retain existing functionality.
Submissions and snapshots retain exact student/session/authority checks,
reordered-event protection, and missed-push recovery. No Chrome permission,
host permission, managed-policy key, or extension update timing changes.

## Deployment order

Deploy the compatible SchoolPilot API/worker and additive
`classpilot-class-tools-expand-20260922` migration before enabling new tools.
The earlier `classpilot-scheduled-classroom-20260915` migration remains a
prerequisite for scheduled classrooms. Preserve existing rollout configuration;
enable the new capabilities and school phases only through the documented
SchoolPilot controls. Live View remains backend-only and the teacher Live View
UI stays disabled.

The public Store listing was fetched directly on September 22, 2026 and showed
2.9.1. Recheck immediately before upload: https://chromewebstore.google.com/detail/classpilot/iggbfegfcjkfieoemeolfmfnapepalca
Submit with deferred publishing and complete the existing managed-Chromebook
operator checks before publishing. This local package is not evidence of a
managed ChromeOS pilot or production backend deployment.

## Verification

The implementation's source checks and real-Chrome resilience suites passed
before the release bump. Run the version guards, typecheck, unit tests and build
for 2.9.2. The canonical packager checks every archived file against its source
bytes and records SHA-256. Run `npm run test:extension:package` against the
unpacked ZIP; this gate now includes the Class tools Chrome suite as well as
scheduled classrooms, auth recovery, worker lifetime, ordering and ACK checks.
Keep the exact local release commit/tag and validation results with the ZIP.

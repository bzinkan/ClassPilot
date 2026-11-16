# ClassPilot 3.0.7 Classroom Focus and sign-in recovery

The Chromebook successor is prepared as **3.0.7**, minimum Chrome **120**. It
retains the reviewed 3.0.6 work-preservation and screenshot behavior and the
parent shared-Chromebook sign-in repair. Root application and Windows package
versions remain independent. This record describes preparation; it does not
identify a live Store or installed managed-device package.

## Scope and coordinated server requirement

Shared Chromebook login recovery prevents a stale prior student's expiry poll
from cancelling a successful credentialed replacement. The isolated sign-in
frame automatically checks an uncertain submission's outcome without replaying
credentials or requiring a page reload. The parent repair and its native
regressions remain intact; see [the recovery contract](SHARED_CHROMEBOOK_LOGIN_RECOVERY.md).

Reviewed Classroom Focus adds a server-owned scope above the existing Flight
Path. It permits Classroom and Google work apps, including student-created
document copies, plus the external websites explicitly disclosed in the review.
External scopes permit the whole website and its subdomains, not just the
literal assignment URL. Known YouTube videos remain precise resources. School
and teacher blocks and separate SSO authority retain precedence. Stop Focus
removes the scope and reveals the prior Flight Path. See
[the scope contract](CLASSROOM_FOCUS_SCOPE.md) for validation, capability
dependencies, rule budgets and storage-schema-4 downgrade behavior.

SchoolPilot must deploy the compatible API, teacher UI and separately reviewed
capability configuration first. Source discovery, OAuth access, review signing,
source revalidation and exact command recipients remain server-owned. The
extension never infers permission from clicks, referrers or Google credentials.
The new capability is not advertised by Windows. Existing clients cannot honor
the new scope; installed version/capability acceptance remains required.

## Validation and final artifact

Use Node 24 or newer and run `npm run check`, `npm test`, `npm run build`,
`npm run test:extension:classroom-focus`, `npm run test:extension:chrome` and
`npm run test:extension:windows:unit`. Package from the final clean, reviewed,
tagged source with `bash extension/package-extension.sh`, then run the full
`npm run test:extension:package` chain against those exact ZIP bytes.

Canonical outputs are `dist/ClassPilot-v3.0.7.zip` and its matching `.sha256`
record. Preserve every 3.0.6 and earlier versioned archive. Record the final
source SHA/tag, exact ZIP SHA-256, allowed-file inventory and fresh source and
unpacked-package verification receipts. A ZIP built before final source review
is a test candidate. Do not replace any reviewed/uploaded archive with different
bytes or use the unversioned compatibility copy as release identity.

The isolated feature-worktree output may be copied to the primary repository's
`dist` only after confirming the destination is absent or already identical.
Verify the copied SHA-256; do not switch or reset the busy primary checkout.

## Publication and managed-device acceptance

No Store upload or publication is authorized by preparation. Immediately before
any separately authorized upload, inspect the authenticated Developer Dashboard
for extension `iggbfegfcjkfieoemeolfmfnapepalca` and confirm its live version and
pending submissions. Uploaded version numbers cannot be reused. CI, merge,
API/web deployment, ZIP preparation, Store publication and device adoption are
separate evidence.

Managed Chromebook acceptance must verify shared student replacement without
login replay/reload, Classroom coursework and Google document copies, reviewed
external application links/query navigation, assigned-only YouTube access,
school/teacher block precedence, Stop Focus restoring the prior Flight Path,
and class/student handoff and sleep/wake recovery. Desktop Chromium and an
unpacked extension do not establish managed ChromeOS adoption. Signing or
releasing Windows packages remains a separate workstream.

# Reviewed Classroom Focus scope

The 3.0.7 source adds `classroomFocusScopeV1` for Chromebook clients. Preparation
does not publish a package, enable a school capability, or establish
managed-device acceptance. The parent shared-login fixes remain included.
Windows does not advertise this capability. Follow the
[3.0.7 candidate record](CLASS_PILOT_3_0_7_CANDIDATE.md) for release custody.

SchoolPilot owns source discovery, teacher review and authority. An explicit
Classroom website Focus can carry:

```ts
screenLock.classroomScope = {
  schemaVersion: 1,
  sourceRevision: string, // 64 lowercase hexadecimal characters
  allowedDomains: string[],
  resources: PreciseAllowedResource[],
}
```

The list contains Classroom, Docs, Drive, Sheets, Slides, Forms, Forms short
links and the external websites explicitly disclosed in the review. A website
scope permits all of that website and its subdomains, including query-dependent
application navigation. This also permits other files in the Google work apps,
so student-created assignment copies work. It is not an exact-link promise.
Known YouTube materials use the existing precise video resource rather than
granting all YouTube. Unlisted redirect destinations remain blocked. Google
credentials, clicks and referrers never add permission.

The scope must accompany an active, explicit HTTPS `classroom.google.com`
destination without URL credentials, query or fragment data. It cannot accompany
`CURRENT_URL`, an inactive lock or a precise Waypoint resource. Its exact keys,
source revision, required seven work domains, canonical unique hosts and precise
resources validate as one unit. Broad `google.com`, the YouTube host families,
and the named authentication roots `accounts.google.com`,
`login.microsoftonline.com` and `accounts.youtube.com` cannot be material website
scopes. Authentication keeps the existing independently authorized SSO policy.

Both `scopedAuthorityChecksV1` and `preciseRestrictionResourcesV1` are prerequisites
for negotiation. Live scope delivery requires `classroomFocusScopeV1` and the
full current exact student/browser/control binding. Missing negotiation,
malformed state or an unsupported browser rule rejects the whole snapshot; a
legacy lock command cannot discard the scope and report success.

The combined website/resource count is at most 200 and serialized scope size at
most 49,152 bytes. Existing classroom rule-ID and 800-regex budgets still apply.
Native RE2 support is checked before atomic installation; the existing strictly
narrower provider fallback never grants a different resource or whole website.
School and teacher blocks retain precedence. The same matcher handles browser
navigation, new tabs, reconciliation and restriction destinations. Approved
work survives routine reconciliation and a late approved navigation cannot be
removed using an earlier off-policy tab decision.

Focus remains an overlay above the independently saved Flight Path. Screen-only
Stop Focus removes its reviewed scope and reveals that prior path. Student
handoff, expiry and fail-private cleanup remove the scope and its native rules.
Storage-only schema 4 plus `classroomScopePersistenceVersion: 1` prevents an older
worker from dropping scope semantics during restoration. Restoration still
requires the existing current student/session ownership fences; the marker does
not supply authentication or SSO authority.

The byte-identical shared fixture is
`server/__tests__/fixtures/classroom-focus-scope-cases.json` here and
`tests/fixtures/classroom-focus-scope-cases.json` in SchoolPilot. Its SHA-256 is
`4b04de889de92a89225d0e5b33bdf9d4f5b0ecce86c95cbe67d21b116bffa0f5`.
The prior precise-resource fixture and its historical hash are unchanged.

Run `npm run test:extension:classroom-focus` for shared matcher, validation and
actual MV3/native DNR acceptance. Both source and unpacked-package suites include
these regressions. Native disposable-browser results remain distinct from an
installed managed Chromebook test and a separately reviewed Store successor.

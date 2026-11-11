# ClassPilot 3.0.6 classroom work preservation

The Chromebook source prepares **3.0.6**, minimum Chrome **120**, based on
`8483a76fea194d69f7d8cd806caa0976778590d8`. It retains the 3.0.5 telemetry,
screenshot efficiency and selected-detail preview fixes. Root application and
Windows package versions remain separate. This record describes a source
candidate, not Store publication, uploaded ZIP identity or fleet adoption.

## Behavior

- Applying a Flight Path retains every currently approved work tab without
  navigating or reloading it, including above an existing numeric tab limit.
  Off-path web tabs close. If an approved work tab exists in another window,
  it is brought forward rather than replacing an unrelated tab with a second
  copy of the landing page.
- Routine state reconciliation, reconnect, worker restore and retries preserve
  existing work, including when the Flight Path is removed or another policy
  snapshot arrives. Browsing restrictions still close off-policy tabs. An
  explicit teacher `limit-tabs` action can reduce that set.
  The full-state command path preserves that distinction even when its snapshot
  arrives before its exact command frame; a stale frame cannot trim newer work.
- Repeated authenticated school settings and first-boot baseline adoption do
  not trim existing tabs. A verified change from a known prior school limit
  still enforces the administrator's policy. The previous raw school value is
  captured before replacing the settings cache.
- New excess tabs are rejected individually. Approved authentication popups
  retain their bounded existing protection without triggering cleanup of older
  work. Pending `onCreated` callbacks retained by every routine Flight Path
  inventory, including initial sync and restore, are coordinated under the exact
  auth binding. This coordination is
  bounded, memory-only and removed when each callback finishes; no durable
  browsing history or per-tab permission is added.
- Destructive reconciliation re-reads exact tabs immediately before a URL
  update/removal. A tab that became approved is retained, and changed identities
  are deferred to a fresh reconciliation.

SchoolPilot separately owns the effective Google work-app bundle for an ordinary
`classroom.google.com` website entry. It freezes the expanded ordinary domain
list at the next explicit apply or automatic occurrence start. The extension
does not infer websites from page links, referrers or Google credentials. It
enforces the authoritative delivered list. Precise resource matching, native
DNR budgets, school/teacher blocks, exact sign-in pass-through, authority,
identity, expiry and rollback fences remain unchanged. No permission, managed
policy key, storage schema, Google scope or new protocol capability is added.

## Verification and release

Focused red/green evidence is kept under ignored
`artifacts/classroom-reliability/`. The new source/package regression
`scripts/test-extension-flight-path-work.mjs` covers preservation above the
numeric limit, exact destructive-boundary rechecks, settings baselines,
authentication popup protection and pending-creation binding. The native Chrome
school-limit suite includes real approved work tabs, repeated reconciliation,
same-value settings refresh, a new excess tab, a held creation callback and
explicit numeric enforcement. Prior 3.0.5 receipts do not validate these bytes.

Before release, run Node 24 `npm run check`, `npm test`, `npm run build` and
`npm run test:extension:chrome`, then package from clean reviewed source with
`bash extension/package-extension.sh` and run the complete
`npm run test:extension:package` gate. Retain exact source/tag, versioned ZIP,
SHA-256, allowed-file inventory and fresh verification receipt. Canonical output
is `dist/ClassPilot-v3.0.6.zip` plus its matching `.sha256` record. Preserve all
older archives and historical records.

Store upload requires a fresh authenticated live-version/pending-submission
check and the operator's release authorization. API/web deployment, source
preparation and package validation do not publish the extension. Managed-device
acceptance must separately verify IXL work remains in place, Classroom opens
Docs/Sheets/Slides/Forms/Drive work, sign-in completes, new excess tabs close,
explicit tab-limit actions reduce tabs, and unrelated websites/YouTube remain
restricted unless separately approved. Do not describe local synthetic browser
checks as managed Chromebook or signed Windows acceptance.

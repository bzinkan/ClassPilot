# ClassPilot 3.0.3 session and command recovery

This candidate starts from merged 3.0.2 source commit
`64202b9ee36b713c6e4aca0cefaf18beacff8e1b`. The extension manifest, package
verifier, release test and ZIP use **3.0.3**. The application package version
is independent of the extension version.

## Changes

- Recover school tab limits from current authenticated settings. Socket update
  messages invalidate the local view rather than replaying an unversioned old
  value. Ordinary settings refresh repairs a missed update.
- Preserve the allowlisted command failure reason in the durable acknowledgement
  outbox so a retry does not replace it with a generic diagnostic.
- Permit commands for a verified active supervision context when an unrelated
  restriction snapshot is withheld. Command authority remains tied to the exact
  current authentication, student/session binding, ownership revision, context
  revision and deadline. This metadata does not apply restrictions.

The SchoolPilot companion changes are merged in PR 694. Exact selected-tab
closing retains its tab identity and snapshot checks. This release adds no
Chrome permission or managed-policy key.

## Validation and package

Run the repository's type, unit, Chrome behavior and unpacked-package gates.
The package verifier checks every allowed archive file byte-for-byte against
the source, the root manifest version, and the versioned archive name. Include
the new recovery regressions in both the Chrome behavior and unpacked-package
aggregates. Record actual results and the source commit beside the final ZIP.

Preserve existing versioned releases. The requested output paths are:

- `C:\GitHub\ClassPilot\dist\ClassPilot-v3.0.3.zip`
- `C:\GitHub\ClassPilot\dist\ClassPilot-v3.0.3.zip.sha256`

Preparation does not upload or publish this package and does not establish
managed-device adoption. Before any future Store upload, confirm the live
version and pending submissions in the authenticated Developer Dashboard for
extension `iggbfegfcjkfieoemeolfmfnapepalca`. Use the recorded ZIP without changing
its bytes. An already uploaded version number cannot be reused.

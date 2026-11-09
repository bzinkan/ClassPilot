# ClassPilot exact-bound storage handoff recovery

The November 9, 2026 investigation reproduced a circular wait in the 3.0.3
extension source. An in-flight FAB lifecycle transition could append an
overlay clear after heartbeat binding adoption had already published its
storage-cleanup barrier. Cleanup waited for the FAB transition; the FAB
transition waited for the overlay clear; the overlay clear waited for cleanup.
The heartbeat and authentication queues then could not progress.

The repair drains the existing writer queues to a stable frontier before
publishing cleanup as their next barrier. Children appended during the drain
remain able to finish. The frontier check and barrier publication are
synchronous, and each cleanup publishes its own completion promise even when
another cleanup has already been requested. Later writers remain behind the
physical purge. Exact authentication-generation checks still run after the
drain and throughout cleanup; a retired identity cannot purge or restore a
replacement student's state.

`npm run test:extension:storage-handoff` exercises the actual MV3 worker with
native Chrome storage and synthetic school responses. It covers the original
overlap, repeated class transitions, a nested overlay child, concurrent
cleanup requests, retired FAB callbacks, writers arriving during physical
purge, cleanup losing its authentication generation, and subsequent
authentication/heartbeat progress. The unchanged baseline fails the overlap
completion assertion. The suite also runs in the source browser aggregate and
the unpacked-package gate.

The existing auth-startup gate also receives a test-only scheduling correction.
Three concurrent page messages can reach a ready worker in separate turns, with
the first reply sent before the other two entries. The disposable worker copy
now holds this marked cohort's replies until all three requests enter, with a
bounded fixture failure if they do not. The production handler and every
cold/warm assertion are retained. This fixture race is separate from the
production storage deadlock.

This source repair adds no permission, wire protocol or collected data. It does
not prepare a newly numbered Store release, upload or publish an extension,
or establish the identity/adoption of any managed-device package. Retain prior
versioned archives. A separately reviewed successor must receive its own
version, verified ZIP and release evidence before any future authorized upload.
Native disposable-browser tests do not establish managed ChromeOS acceptance.

## Validation on November 9, 2026

Node 24.22.1 completed the following gates:

- `npm run check`, `npm run build` and `npm test` (20 files, 209 tests).
- `npm run test:extension:chrome`, including all source behavior and 20
  historical expected-red regressions against immutable older sources.
- `npm run test:extension:package`, including the 27-file source-byte inventory
  and the full unpacked behavior/recovery suites.
- `npm run test:extension:windows:unit` (13 tests) and
  `npm run test:extension:windows` (both development ZIP inventories and actual
  Chrome 156.0.8078.80 / Edge 157.0.4341.42 worker parity).

The new storage-handoff regression passed in the default Playwright browser
151.0.7922.34 and actual Chrome 156.0.8078.80. The latter used an external
disposable test copy with the same CDP unpacked-extension loader as the existing
Windows gate; all regression assertions and production bytes were unchanged.
The corrected startup fixture passed against both unchanged baseline and
repaired source before the final aggregates.

The isolated verification ZIP is a test candidate, not a Store successor.
Its SHA-256 is
`27d2b5f52971c2ccc9aa9a794ba2d8f315e6dffb5454af82ec96381bef1661b0`;
the worker SHA-256 is
`749941c7b5486909ca5db24e9e520deed48c56009109a017d4a786b95e72b67d`.

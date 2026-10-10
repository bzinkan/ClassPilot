# Poll replay wire fixture

`schoolpilot-poll-replay-contract.json` contains synthetic start and close frames
captured from SchoolPilot commit `817dfeff`. The integration test creates the
canonical poll, applies production replay eligibility, and invokes the real
`frameFor` command builder. It does not hand-build an extension-shaped command.

Regenerate from the SchoolPilot repository with an isolated, converged test
database configured through `DATABASE_URL` and `ADMIN_DATABASE_URL`:

```powershell
$env:CLASSPILOT_REPLAY_FRAME_FIXTURE_OUTPUT = 'C:/temp/schoolpilot-poll-replay-contract.json'
node --import ./tests/test-environment.mjs --import tsx --test tests/classpilot-transient-command-replay.integration.test.ts
```

The capturing test is named “poll replay requires the successor for starts and
closes, and rejects answered or stale canonical resources”. Its ordinary and
restricted-role RLS lanes passed 12/12 when this fixture was captured.

The ClassPilot browser harness reads this baseline by default. To consume a
fresh server output, set `CLASSPILOT_REPLAY_FRAME_FIXTURE` before running
`npm run test:extension:poll-replay`. The harness maps only the synthetic
transport identity/classroom and deadlines to its local browser session;
command shape, ordering, delivery policy, options and poll ID remain intact.
Frames enter through the actual extension `handleWsMessage` handler.

# ClassPilot 3.0.0 connection reliability release

This successor is based on `40af839d` (2.9.9) and is prepared as 3.0.0.
A read-only check of the public Store listing on October 15, 2026 showed 2.9.9,
updated October 10. Pending submissions could not be checked because browser
navigation to the developer dashboard was unavailable. Recheck both immediately
before uploading the final verified `dist/ClassPilot-v3.0.0.zip` and record its
source commit and SHA-256. No Store submission or managed-device adoption is
claimed by preparing this release.

## Behavior

- Navigation, screenshot-policy refresh and other event heartbeats retain one
  pending latest event while a request or server cooldown is active. A periodic
  heartbeat can consume an already due event. Sign-out or identity replacement
  clears pending work. Ten-second cadence and two-second coalescing remain.
- Command/chat acknowledgement HTTP attempts have an eight-second deadline
  covering headers and response body after the existing server cooldown.
  Timeout aborts the attempt, retains the same exact-bound persisted ACK ID,
  releases singleflight and retries through existing backoff. Authentication
  cancellation remains separate. Authentication frames launch receipt flushes
  without awaiting their network completion.
- The offscreen proxy uses a ten-second transport probe and five-second reply
  deadline only after an authenticated server advertises `transportProbeV1`.
  The additive `transport-probe`/`transport-probe-reply` nonce exchange proves
  transport liveness only. It grants no identity, presence, license or control
  authority. Servers without the hint retain the previous ping fallback.
  Any inbound frame cancels a probe deadline. A callback over two seconds late
  sends a fresh probe, so sleep/throttling alone never retires a socket.
- One awake reconnect timer uses exponential full jitter from one second to a
  thirty-second cap; the alarm survives worker termination. The existing
  fifteen-second authentication-in-flight fence remains. Policy/auth rejection
  asks for authoritative HTTP authentication recovery before fast retry.
- WebSocket ingress reserves order before identity/policy readiness and adopts
  a surviving socket only through exact offscreen status. At most 32 pending
  ingress operations are retained in memory; overflow requests an authoritative
  snapshot and never persists or replays raw frames. Transient commands retain
  their original expiry and are checked again before execution or first browser
  side effect after asynchronous validation.

The server protocol stays 3. No extension capability, permission, managed
policy, generic command replay or collected data is added. Persistent controls,
durable messages and ordered polls retain their existing recovery contracts.
Active screenshots remain five seconds; background screenshots remain thirty.

## Verification and release gates

Run `npm run check`, `npm test`, `npm run test:extension:chrome`, and
`npm run build`. The Chrome aggregate includes
`npm run test:extension:connection`; it exercises the actual MV3 worker with
network resolution blocked and synthetic school transports. The offscreen
suite separately covers legacy fallback, probe replies, silence retirement,
late timer recovery and generation retirement.

The manifest and package guard both require the requested 3.0.0 version. Before
upload, verify the live Store listing and pending submissions and bind the clean
source commit and versioned ZIP SHA-256 to the evidence. Deploy the compatible server
hint/echo before evaluating the accelerated recovery target. Rollback to an
older server keeps the legacy transport fallback.

Physical acceptance requires the exact packed package on managed Chromebooks:
ordinary class operation, native worker suspension, sleep/wake, Wi-Fi change,
blackholed socket, lost ACK receipt, offline recovery and an identity switch.
For awake timers and a usable server, require blackhole detection within fifteen
seconds and authoritative status/preview recovery within thirty seconds.
Actual sleeping/throttled periods must show stale status rather than promise a
timer bound Chrome cannot execute.

Capacity stress testing is outside this focused connection-reliability release.
Existing failed capacity campaigns remain failed; this release makes no capacity
claim and does not authorize another capacity workload or infrastructure change.

Validation on 2026-10-13 used Node 24: typecheck, 205 unit tests, production
build and the complete Chrome aggregate passed. The final worker SHA-256 was
`6a49379e3ed92c5d3d68b0ac345f69ca29207e96f3f0a9a9177afe5384ab6822`.
A subsequent test-only strengthening also passed with the native two-second
coalescing callback firing during a held real heartbeat, followed by exactly
one fresh native-tab snapshot. The same focused lane verified stalled
successful ACK bodies and immediate cancellation of stalled 429/503 bodies.
These are local regression receipts, not managed adoption or capacity proof.

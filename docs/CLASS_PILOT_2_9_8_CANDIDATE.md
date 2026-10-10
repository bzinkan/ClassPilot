# ClassPilot 2.9.8 candidate: connection smoothing

2.9.8 is a connection-only release on top of 2.9.7. It adds no permission, no
capability, no managed-policy key, no wire-protocol change and no collected
data. The manifest keeps the existing extension identity and the Chrome 120
floor. Wire protocol remains 3; the precise classroom wire schema remains 1.

It follows the 2026-10-09 production audit of the student WebSocket lane. The
fleet was on 2.9.7: the Chrome Web Store publishes 2.9.7 and every
`/api/extension/settings` request on 2026-10-08 carried the 2.9.7 capability
list. The connection code is byte-identical between 2.9.6 and 2.9.7, so the
numbers below describe both. The server was healthy (three API tasks, ALB p95
59 ms, zero 5xx). The roughness was on the client side of the socket.

## What changes

### 1. One socket per authentication attempt

`connectWebSocketNow()` returns as soon as the offscreen proxy accepts
`WS_CONNECT`, long before the server answers the `auth` frame, and every
adopted response re-enters the connect path (each ten-second heartbeat
included). Through 2.9.7 the second caller saw "same generation, transport
open, not authenticated", bumped the generation, and the proxy closed the
socket that was still authenticating.

Production on 2026-10-08: 138 of 631 student WebSocket authentications (21.9%)
ended as `WS_AUTH_SOCKET_CLOSED` although server-side authentication took
about 55 ms; 340 of 720 Chromebook sockets lived under 15 seconds.

`recoverOffscreenWebSocketStatus()` now returns `WS_RECOVERY_AUTH_IN_FLIGHT`
while this worker's own connect attempt for the reported generation is
unsettled, its socket is CONNECTING or OPEN, and a bounded grace
(`WS_AUTH_INFLIGHT_GRACE_MS`, 15 s) has not elapsed. The caller then leaves the
socket alone. The attempt is settled by auth-success, auth-error, a relayed
close, or a `WS_NOT_OPEN` send failure; a settled attempt is replaceable at
once. A restarted worker has no response guard and keeps the existing
re-adoption path. Identity mismatch, older generations and the fail-private
Live View branch are unchanged and run first.

The heartbeat-response re-entry stays. It is the fast reconnect lane after a
socket drop, because a packed extension's `ws-reconnect` alarm cannot fire
sooner than about thirty seconds, and it re-probes the offscreen document.

### 2. Silent sockets are retired

The server answers every application `ping` with `{type:'pong'}`. Nothing read
that reply, the browser answers protocol pings itself, and a half-open socket
(Wi-Fi roam, sleep, NAT rebinding) keeps `readyState` OPEN until TCP gives up.
Measured in class on 2026-10-07: 7.5 to 29 s to recover after a network cut,
open-ended on a black-holed path.

The offscreen proxy now counts unanswered pings. An authenticated socket with
two or more unanswered pings and at least 50 s without any inbound frame is
retired immediately, without waiting for a closing handshake, and the close is
relayed with code 4000. Counting pings rather than wall-clock time keeps a
throttled keepalive timer from retiring a healthy socket. Ordinary closes now
relay their close code and clean flag.

`wsSend()` also treats a `WS_NOT_OPEN` answer for the current generation as
transport loss: it clears the connected state and reconnects, instead of
continuing to believe in a socket the proxy no longer holds.

### 3. Acknowledgement fallbacks keep their delay in the packed build

`scheduleCommandAckFlush()` and `scheduleChatAckFlush()` scheduled only a
`chrome.alarms` alarm. Packed extensions cannot fire an alarm sooner than their
thirty-second poll, so the five-second HTTP fallback was ten to thirty seconds
on every managed Chromebook while every unpacked test build saw five. Both now
keep an in-memory timer while the worker is alive, with the alarm as the
durable fallback across worker termination. This is the pattern
`scheduleMonitoringEventFlush()` and the prompt student-chat flush already use.

## What does not change

- No reconnect backoff constants, heartbeat cadence, FAB cadence or request
  timeouts change. `HEARTBEAT_INTERVAL_MS`, `wsReconnectBackoffMs`,
  `COMMAND_ACK_HTTP_FALLBACK_MS` and the 25 s keepalive are now pinned by the
  release guard for the first time.
- Class Tools, Attention, Focus, precise restrictions and private chat code
  paths are untouched.
- The server needs no change. 2.9.6, 2.9.7 and 2.9.8 interoperate with the
  deployed API.

## Verification

- `npm run check` and the full unit suite pass, including a new 2.9.8 release
  guard in `server/__tests__/extension-release.test.ts`.
- `scripts/test-extension-resilience.mjs` gains a sign-in fixture that drives
  the real `connectWebSocket()` path with only the offscreen RPC replaced. It
  asserts one `WS_CONNECT` across re-entries while connecting, while open and
  unauthenticated, and while the proxy has seen auth-success that the worker
  has not adopted; replacement after the grace; and immediate replacement of a
  settled attempt. On the 2.9.7 source the same fixture sends a second
  `WS_CONNECT` on the first re-entry.
- `scripts/test-extension-offscreen-identity.mjs` gains liveness cases:
  answered pings never accumulate, recent inbound traffic defers retirement,
  two unanswered pings plus bounded silence retire the socket without a
  further ping and report exactly one close, an unauthenticated socket is never
  retired, and an ordinary close relays its code.

## Release gates still open

1. **Packed-build acceptance on a managed Chromebook.** Unpacked builds have no
   alarm minimum, so only a packed build shows the acknowledgement fallback and
   reconnect timing the fleet will see. Check on at least one device, ideally
   two, for one class period:
   - ALB access logs show one Chromebook socket per sign-in for that device and
     no 0 to 2 second sockets.
   - `student_websocket_auth_failure` (`WS_AUTH_SOCKET_CLOSED`) is absent for
     that device.
   - After a forced Wi-Fi toggle the socket reopens within about ten seconds.
2. **Chrome Web Store submission and deferred publish.** The Store cannot
   downgrade an installed client. Rollback is a forward release.
3. **Fleet adoption watch.** Roster, Chromebook Status, Version column. Expect
   the fleet-wide `WS_AUTH_SOCKET_CLOSED` share to fall from about 22% toward
   zero and daily `WebSocketDisconnect` to roughly halve as devices update.

## Deferred to a later release

- An in-worker one to two second reconnect fast path. The heartbeat lane
  already reconnects within ten seconds; a faster loop needs a server close
  code contract first.
- Prompt classroom-state expiry after a worker restart with an invalid marker
  (`when: Date.now() + 1` alarms).
- Event heartbeats dropped rather than deferred while one is in flight, the
  `classroomState: null` heartbeat fence, frames discarded during worker wake,
  and the serial Attention broadcast. Each needs a device-side verification
  pass before any change.

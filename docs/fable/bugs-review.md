# Correctness / bug review — library packages

Reviewer: Claude (Fable model), review-only pass over `packages/orpc-ws-client` and
`packages/orpc-ws-server` source (plus shared seams), cross-checked against the existing
unit/integration suites (`bug-01`, `bug-06`, `bug-08`, per-module `__tests__/`). The
existing regression tests cover the 11 historical bugs well at the *module* level; nearly
all new findings below are **composition-level lifecycle gaps** — interactions between
`ReconnectManager`, the composition root's `connect()`/`dispose()`, partysocket's
internal retry loop, and the heartbeat watchdog that no current test exercises. The most
serious cluster: `dispose()` does not stop the reconnect machinery (zombie connections),
`connect()` is not actually idempotent during the auto-retry window (duplicate sockets),
"terminal" auth failure never tears anything down (unbounded `onTerminalAuthFailure`
firing), and a failed heartbeat-timeout recovery permanently latches the watchdog while
the state lies `connected`.

All `file:line` references verified by reading the code at review time.

## Findings table

| ID | Severity | Likelihood | Area | One-liner |
|----|----------|-----------|------|-----------|
| BUG-1 | High | Medium | client reconnect/dispose | `dispose()` doesn't cancel ReconnectManager timers / in-flight recovery → zombie WS resurrected after dispose |
| BUG-2 | High | Med-High | client connect() | `connect()` during the auto-retry window creates a second partysocket; the old one is never closed |
| BUG-3 | High | High | client auth flow | "Terminal" auth failure isn't terminal: no teardown, `onTerminalAuthFailure` fires repeatedly, refresh retried forever |
| BUG-4 | High | Medium | client heartbeat+reconnect | Failed refresh on the heartbeat-timeout path is swallowed; watchdog latch never resets; client stuck `connected` forever |
| BUG-5 | Medium | Medium | client reconnect | Storm guard not applied to the `reconnect()` path — violates the locked "single window across all triggers" design; double-refresh races possible |
| BUG-6 | Medium | Low | client lifecycle | No stale-wrapper guard on `open` — a late open from a replaced wrapper corrupts state and the Bug-10 flag (Bug-4 regression in a race) |
| BUG-7 | Medium | Low-Med | client heartbeat | Concurrent `subscribe()` calls leak an unabortable consumption loop that keeps feeding the watchdog |
| BUG-8 | Medium | Medium | server upload | HTTP upload context omits `token`; WS context includes it — same router, divergent context shape |
| BUG-9 | Low | Medium | server upload | Early-reject (401 / beforeUpload) responds without draining/destroying the request stream |
| BUG-10 | Low | Low | client sleep | Blob URL created per `start()` is never revoked; comment's "one per detector instance" claim is wrong |

---

## BUG-1 — Zombie reconnect after `dispose()`

> **✅ RESOLVED** (verified + fixed). `ReconnectManager.dispose()` added (clears
> debounce timer, resolves pending resolvers, `disposed` latch re-checked after
> every `await`); wired from client `dispose()`; `TokenRefreshHandler.isDisposed`
> guard refuses post-dispose socket swaps. Test:
> `bug-12-zombie-reconnect-after-dispose.test.ts`. Tests pass.

- **Severity:** High. **Likelihood:** Medium (dispose during an active debounce/refresh
  window — routine in a React app unmounting during network churn).
- **Location:**
  - `packages/orpc-ws-client/src/index.ts:542-570` (`dispose()` — never touches
    `reconnectManager`)
  - `packages/orpc-ws-client/src/reconnect/reconnect-manager.ts:220-242` (debounce timer;
    the class has **no** dispose/cancel API — the docblock at line 96-97 says "dispose by
    simply dropping the reference", which is false while a timer is armed)
  - `packages/orpc-ws-client/src/reconnect/token-refresh-handler.ts:180-219`
    (`reconnectWithNewToken` unconditionally creates and installs a new WS)

**The bug.** `dispose()` stops the heartbeat, closes the current WS, clears the holder,
and sets terminal state — but a `reconnect()` sitting in the debounce window, a
`runReconnect` mid-jitter-delay, or a `tryAuthRecovery` awaiting `tokenProvider.refresh()`
all survive it. When the timer fires / the refresh resolves, `refreshAndReconnect()` runs
to completion:

```ts
// token-refresh-handler.ts:209-215 — runs after dispose() with nothing to stop it
const newWs = this.websocketFactory.create(
  this.createUrlProvider(),
  this.getEventHandlers(),
  this.reconnectConfig,
);
this.websocketHolder.set(newWs);
```

A brand-new partysocket is created post-dispose, the holder is repopulated, and when it
opens, `handleOpen` flips the supposedly-terminal state back to `connected` and restarts
the heartbeat subscriber. The "dead client object" contract
(`index.ts:224-229`) is violated; the connection leaks for the page lifetime.

**Trigger.** Heartbeat timeout (or sleep-wake) fires → `reconnectManager.reconnect()`
schedules the debounce timer → consumer calls `client.dispose()` → 100 ms later the
timer fires → token refreshed, new WS connected.

**Existing coverage:** absent. `composition-root.test.ts:252-278` only checks that a
*manual* `connect()` after dispose is a no-op; `reconnect-manager.test.ts` never disposes.
Propose `bug-12-zombie-reconnect-after-dispose.test.ts`.

**Proposed fix.** Add `dispose()` to `ReconnectManager`: clear `reconnectDebounceTimer`,
resolve pending resolvers, set a `disposed` latch checked at the top of `runReconnect`
and `tryAuthRecovery` (and again after each `await`). Call it from the client's
`dispose()`. Belt-and-braces: a `disposed` guard in
`TokenRefreshHandler.reconnectWithNewToken` (or have the composition root's
`getEventHandlers`/factory refuse post-dispose).

**Confidence:** High.

---

## BUG-2 — `connect()` during the auto-retry window creates a duplicate socket

> **✅ RESOLVED** (verified + fixed). `connect()` now no-ops when
> `websocketHolder.get() !== null` (after the terminal/status guards) — a
> wrapper in the holder means the library already owns reconnect, so a
> retry-window `connect()` no longer creates a second socket. Test:
> `bug-13-connect-during-retry-duplicates-socket.test.ts`. Typechecks; run the
> client suite to confirm.

- **Severity:** High. **Likelihood:** Medium-High (any consumer that calls `connect()`
  from a React effect / route change while the link is in a retry window — exactly the
  "idempotent, call it freely" usage the docs invite).
- **Location:** `packages/orpc-ws-client/src/index.ts:512-540`

**The bug.** The idempotency guard only excludes `connecting` / `connected` / `kicked`:

```ts
if (s.status === "connecting" || s.status === "connected" || s.status === "kicked") {
  return;
}
connectionState.setState(connecting());
const ws = websocketFactory.create(urlProvider, createFreshHandlers(), reconnectConfig);
websocketHolder.set(ws);
```

But after **any** drop the state is `disconnected({ willRetry: true })` while the
existing partysocket wrapper is still auto-retrying internally (default
`maxRetries: Infinity`). A `connect()` call in that window passes the guard and creates a
**second** wrapper. `websocketHolder.set(ws)` overwrites the reference; the old wrapper is
**never closed** and keeps reconnecting forever. Consequences:

- Two live server connections per client (bandwidth, server resources).
- With the server's `singleConnectionPerUser` (default on), the two wrappers perpetually
  kick each other with 4005: when the *old* wrapper reconnects, the registry kicks the
  *current* one — whose 4005 close is NOT stale (it is the holder's WS) — so the client
  transitions to terminal `kicked` even though the user never opened another tab.
- The orphaned wrapper's `open` events are not stale-guarded either (see BUG-6), further
  corrupting state.

**Trigger.** Connect → pull network cable (state `disconnected(1006, willRetry:true)`) →
consumer calls `client.connect()` (e.g., a "retry now" button, or an effect re-run) →
two sockets.

**Existing coverage:** `composition-root.test.ts:231-250` only tests three synchronous
`connect()` calls from the initial state. Propose
`bug-13-connect-during-retry-duplicates-socket.test.ts`.

**Proposed fix.** Treat "a wrapper exists in the holder and the client is not disposed"
as already-connecting: either no-op when `websocketHolder.get() !== null`, or explicitly
`close()` the old wrapper before creating the new one (mirroring
`reconnectWithNewToken`'s swap sequence). The first option matches the documented
"library owns all reconnect logic" contract.

**Confidence:** High.

---

## BUG-3 — Terminal auth failure is not terminal

> **✅ RESOLVED** (verified + fixed). Single-fire `terminalFired` latch in
> `ReconnectManager` + composition-root teardown (close wrapper → clear
> holder/link → `disconnected({willRetry:false})` → callback once); `connect()`
> guarded after terminal; no-tokenProvider branch routes through the same path.
> Test: `bug-14-terminal-auth-failure-not-terminal.test.ts`. Tests pass.

- **Severity:** High. **Likelihood:** High — every session whose refresh token expires
  while the tab stays open walks straight into it.
- **Location:**
  - `packages/orpc-ws-client/src/reconnect/reconnect-manager.ts:166-206`
    (`tryAuthRecovery` — fires the callback but tears nothing down; the storm-guard-trip
    branch at 170-181 does not stamp `lastRefreshAttemptedAt`, and nothing latches
    "we already went terminal")
  - `packages/orpc-ws-client/src/index.ts:392-410, 416-444` (wiring — neither
    `onTerminalAuthFailure` path closes the wrapper or moves state)

**The bug.** The public contract (`index.ts:147-155`) says: *"The client is terminal
after this fires; create a new one post-re-auth to reconnect."* The implementation never
makes that true. After `refresh()` returns `null` (terminal #1):

1. The partysocket wrapper is untouched — it keeps auto-retrying with the stale token
   (the Bug-1 URL provider rereads `getToken()`, which still returns the stale value).
2. Each retry is rejected with 1008 → `handleClose` → `auth-recovery` →
   `onAuthRecoveryNeeded` → `emit({type:"auth_failure", refreshable:true})` (a lie — the
   library already gave up) → `tryAuthRecovery` → storm guard trips → **terminal #2, #3,
   #4…** on every backoff attempt.
3. Once 30 s elapse past the last stamp, the guard passes again and the library performs
   **another network refresh**, fails, and the cycle repeats forever — connection storm
   against both the WS endpoint and the IdP, plus unbounded duplicate redirects/toasts in
   the consumer's `onTerminalAuthFailure`.
4. `state` stays `disconnected({ willRetry: true })` forever — the UI is told the library
   is still retrying, even though it has "given up".

The same repeated-firing applies to the no-tokenProvider branch
(`index.ts:421-438`), which goes terminal on *every* close-triggered recovery.

**Trigger.** Leave a tab open until the refresh token expires; server starts 1008-ing.

**Existing coverage:** `reconnect-manager.test.ts:213-298` covers single-shot storm-guard
semantics in isolation; nothing covers the loop across partysocket retries or the
"terminal means terminal" contract. Propose
`bug-14-terminal-auth-failure-not-terminal.test.ts`.

**Proposed fix.** On terminal failure: (a) latch a flag in `ReconnectManager` so
`onTerminalAuthFailure` fires at most once per client; (b) close the current wrapper
(`wrapper.close()` flips partysocket's `_closeCalled` and stops the retry loop — same
technique the 4005 branch already uses at `event-handlers.ts:207-213`); (c) transition
state to `disconnected({ willRetry: false })` (or a dedicated terminal variant) so UI and
`connect()`-guards agree.

**Confidence:** High.

---

## BUG-4 — Failed heartbeat-timeout recovery permanently latches the watchdog; state stuck `connected`

> **✅ RESOLVED** (verified + fixed). `runReconnect` now honors
> `refreshAndReconnect()`'s boolean and routes a null refresh to the single-fire
> terminal path (gated on `canRefresh` so cookie-auth does not go terminal — a
> regression caught in review, see BUG-15b note); heartbeat timeout transitions
> `connected → disconnected({willRetry:true})` so the UI never lies. Tests:
> `bug-15-...` + `bug-15b` cookie-auth case. Tests pass.

- **Severity:** High. **Likelihood:** Medium (wake-from-sleep with an expired refresh
  token and a half-open socket — the exact scenario the watchdog exists for).
- **Location:**
  - `packages/orpc-ws-client/src/reconnect/reconnect-manager.ts:277` — the boolean from
    `refreshAndReconnect()` is discarded in `runReconnect` (contrast `tryAuthRecovery`
    lines 191-205, which honors it)
  - `packages/orpc-ws-client/src/heartbeat/monitor.ts:116, 200-203, 221` — `timeoutFired`
    latch is reset **only** by `recordPing()` / `configure()`
  - `packages/orpc-ws-client/src/index.ts:466-478` — heartbeat timeout changes no state

**The bug.** Heartbeat timeout on a half-open zombie socket (no close event will ever
arrive) fires `reconnect()`. If `tokenProvider.refresh()` returns `null`:

```ts
// reconnect-manager.ts:277 — result silently dropped
await this.tokenRefreshHandler.refreshAndReconnect();
this.logger.info("reconnect-manager: safe reconnect completed");
```

No WS swap happens, no `onTerminalAuthFailure`, no event, no retry. Meanwhile:

- `state` is still `connected` (heartbeat timeout never transitions state; only close
  events do, and the zombie never closes).
- The monitor's `timeoutFired` latch is set and can only be cleared by a `recordPing()`
  that will never come — the watchdog **never fires again**.

Net result: the client silently displays "connected" forever, RPCs hang/fail, and every
recovery mechanism is disarmed. One failed recovery = permanent zombie.

**Trigger.** Laptop sleeps > token lifetime → wake → worker tick drives
`woke_from_sleep` → `reconnect()` → refresh fails → stuck. (Same via the watchdog path
without sleep detection.)

**Existing coverage:** `monitor.test.ts:204-241` pins "fires once per window" (the latch
itself); nothing covers the latch + failed-recovery composition. Propose
`bug-15-heartbeat-timeout-refresh-failure-stuck-connected.test.ts`.

**Proposed fix.** In `runReconnect`, honor the result: on `false`, fire
`onTerminalAuthFailure` via the same single-fire path as BUG-3's fix (this *is* "refresh
returned null", which the locked auth contract maps to terminal). Independently, consider
transitioning state to `disconnected({ willRetry: true })` when the watchdog fires, so
the UI never shows `connected` on a dead link.

**Confidence:** High.

---

## BUG-5 — Storm guard bypassed by the `reconnect()` path (design deviation + double-refresh race)

> **✅ RESOLVED** (verified + fixed, full scope). `runReconnect` now consults +
> stamps the shared `lastRefreshAttemptedAt` window; within-window it rebuilds
> with the current token (new `TokenRefreshHandler.reconnectWithCurrentToken()`)
> instead of re-refreshing, and never goes terminal (unlike `tryAuthRecovery`).
> `tokenProvider.refresh()` is single-flighted so concurrent triggers can't
> double-refresh (kills the rotation self-logout). Cookie-auth (`!canRefresh`)
> now actively rebuilds rather than no-oping. A follow-on race the shared window
> exposed — an in-flight reconnect refresh resolving *after* a concurrent
> terminal trip and resurrecting the socket — is closed by extending the swap
> guard to `disposed || terminalAuthFired`. Tests: `bug-16-...` (window +
> single-flight) and `bug-16b-...` (no swap after terminal); `bug-15` cookie-auth
> case updated. Typechecks; run the client suite to confirm.

- **Severity:** Medium. **Likelihood:** Medium under churn.
- **Location:** `packages/orpc-ws-client/src/reconnect/reconnect-manager.ts:220-293`
  (`reconnect()`/`runReconnect` neither read nor stamp `lastRefreshAttemptedAt`);
  config defaults at `packages/orpc-ws-client/src/config/reconnect-config.ts:91-93`.

**The bug.** CLAUDE.md's locked decision: *"Library owns the 30s storm guard internally.
**Single window across all triggers** (heartbeat timeout, close-code 1008/4001, pre-open
1000, HTTP-upload 401)."* The implementation guards only `tryAuthRecovery`. The
heartbeat-timeout and sleep-wake triggers go through `reconnect()`, where each invocation
performs a full `tokenProvider.refresh()` network call gated only by a 100 ms debounce
and ≤1 s jitter. Two concrete consequences:

1. A flapping connection (heartbeat timeout every ~45 s, or repeated wake ticks) hammers
   the IdP with refreshes that the design says must share the 30 s window.
2. `reconnect()`'s refresh does not stamp the window, and `tryAuthRecovery`'s refresh is
   not visible to `reconnect()`'s mutex (its `reconnectInProgress` is a separate flag,
   and `TokenRefreshHandler`'s own mutex covers only the synchronous swap, not the
   `await refresh()` — see `token-refresh-handler.ts:154-168`). A heartbeat-timeout
   reconnect and a 1008-triggered auth recovery can therefore run
   `tokenProvider.refresh()` **concurrently**. With IdP refresh-token rotation (Keycloak
   reuse detection), concurrent reuse of the same refresh token can revoke the whole
   session — a self-inflicted logout. This is exactly the "two independent storm-guard
   timestamps" drift the library claims to have fixed (reconnect-manager.ts:8-15), now in
   a new shape: one guarded trigger, one unguarded.

**Trigger.** Half-open zombie (heartbeat timeout → `reconnect()` starts refresh) while
the server simultaneously rejects a parallel partysocket retry with 1008
(→ `tryAuthRecovery` starts a second refresh).

**Existing coverage:** none — `reconnect-manager.test.ts:301-449` tests debounce/jitter/
mutex but never mixes the two entry points or asserts the shared window. Propose
`bug-16-reconnect-path-bypasses-storm-guard.test.ts`.

**Proposed fix.** Stamp + consult `lastRefreshAttemptedAt` in `runReconnect` too. The
trip semantics must differ from auth-recovery: inside the window, *skip the refresh* and
reconnect with the current token (or no-op and let partysocket retry) rather than firing
terminal. Additionally (or alternatively) single-flight `refresh()` inside
`TokenRefreshHandler` so concurrent callers share one promise.

**Confidence:** High that the deviation is real (the design text is explicit); Medium on
the practical severity of the rotation race (depends on the consumer's TokenProvider).

---

## BUG-6 — No stale-wrapper guard on `open`

- **Severity:** Medium. **Likelihood:** Low (browser event-queue race), but the damage
  reintroduces historical Bug 4.
- **Location:**
  - `packages/orpc-ws-client/src/lifecycle/event-handlers.ts:130-142` (`handleOpen` —
    no wrapper parameter, no identity check; contrast `handleClose` at 157-166)
  - `packages/orpc-ws-client/src/lifecycle/websocket-factory.ts:74-76` (`ws.onopen` does
    not closure-bind `ws` the way `ws.onclose` does at 77-92)

**The bug.** Bug 9's stale-WS guard exists only for close events. During a token-refresh
swap (`reconnectWithNewToken`), the old wrapper is `close()`d and replaced in the holder
— but if the old wrapper's handshake completed just before the swap, its `open` event can
already be queued and will still be delivered. `handleOpen` then runs against the *new*
holder state:

```ts
this.websocketHolder.markCurrentAttemptOpened();   // marks the NEW wrapper's attempt!
this.connectionState.setState(connected());        // while the new WS is still CONNECTING
this.runOnOpenHook();                              // heartbeat subscribe against a non-OPEN link → throws (caught, loop dead)
```

The worst effect is the flag corruption: the new wrapper's `currentAttemptOpened` becomes
`true` before it ever opened, so a pre-open close-1000 on the new wrapper routes to
`normal-disconnect` instead of `auth-recovery` (`close-decision.ts:108-113`) — i.e. the
masked-handshake-failure silent loop that Bug 4 fixed, resurrected in a race. BUG-2 above
widens the exposure (a permanently orphaned wrapper produces open events indefinitely).

**Trigger.** Token refresh swap racing the old socket's handshake completion; or any
orphaned wrapper from BUG-2 reconnecting.

**Existing coverage:** `event-handlers.test.ts:103-132` covers stale **close** only.
Propose `bug-17-stale-ws-open-clobbers-state.test.ts`.

**Proposed fix.** Mirror the close path: extend `WebSocketEventHandlers.onOpen` to
`(event, wrapper)` (`lifecycle/types.ts:50`), closure-bind `ws` in the factory, and in
`handleOpen` ignore the event when `wrapper !== websocketHolder.get()`.

**Confidence:** High on the logic gap; Medium on how often browsers deliver the queued
open after `close()` (implementation-dependent — which is precisely why the guard should
exist).

---

## BUG-7 — Concurrent `subscribe()` leaks an unabortable heartbeat loop

- **Severity:** Medium. **Likelihood:** Low-Medium (needs two `subscribe()` calls
  overlapping one draining loop — possible under fast open→close→open churn, since the
  composition root calls `void heartbeatSubscriber.subscribe()` on every open,
  `index.ts:446-454`).
- **Location:** `packages/orpc-ws-client/src/heartbeat/subscriber.ts:118-150`

**The bug.** The re-entry barrier is not atomic across its `await`:

```ts
if (this.abortController || this.activeLoop) {
  this.unsubscribe();
  const prior = this.activeLoop;
  this.activeLoop = null;          // <-- second caller now sees a clean slate
  if (prior) await prior;          // <-- suspension point
}
const controller = new AbortController();
this.abortController = controller; // <-- first caller resumes and overwrites
```

Sequence: open#1 → loop-1. close → `unsubscribe()`. open#2 → `subscribe()` A: fields
nulled, awaits loop-1. open#3 → `subscribe()` B: both fields are `null`, so B skips the
barrier, starts loop-3, installs its controller. A then resumes, starts loop-2, and
**overwrites** `abortController`/`activeLoop` — loop-3's controller is now unreachable.
`unsubscribe()`/`stop()`/`dispose()` can never abort loop-3; it keeps consuming the
stream and calling `monitor.recordPing()` (subscriber.ts:226-229), permanently feeding
the watchdog from a stale subscription and masking real heartbeat timeouts. This defeats
the class's own stated invariant ("guarantees a single live consumption loop",
subscriber.ts:115-117).

**Existing coverage:** `subscriber.test.ts:457-489` tests *sequential, awaited*
re-subscribes only. Propose `bug-18-concurrent-subscribe-leaks-loop.test.ts`.

**Proposed fix.** Serialize subscribes through a promise chain
(`this.tail = this.tail.then(() => startFresh())`) or use a generation counter: capture
`const gen = ++this.generation` before the await and bail (or abort the fresh controller)
if `this.generation !== gen` after it.

**Confidence:** High (pure logic race, deterministic once interleaved).

---

## BUG-8 — HTTP upload context omits `token`; WS context includes it

- **Severity:** Medium (for consumers whose procedures read `context.token`).
  **Likelihood:** Medium — the whole point of the design is "one router, two transports".
- **Location:**
  - `packages/orpc-ws-server/src/upload/http-handler.ts:287-291` —
    `context: { user: auth.user }` only
  - `packages/orpc-ws-server/src/lifecycle/connection-handler.ts:156` —
    `context: { user, token }`

**The bug.** The WS transport's procedure context is `{ user, token }` (the
connection-handler comment at 139-141 even pitches the token for "proxying to upstream
services"). The HTTP upload transport executes procedures from the *same composed router*
but builds context with `user` only. A procedure that reads `context.token` (e.g. to
forward auth to an object store or downstream API) works over WS and silently receives
`undefined` over HTTP. The Bearer token is actually extracted in `runVerify`
(http-handler.ts:140) and then discarded.

**Existing coverage:** `upload-flow.test.ts` / `http-handler.test.ts` don't assert context
parity. Propose `bug-19-http-context-missing-token.test.ts`.

**Proposed fix.** Have `runVerify` return `{ result, token }` (it already computed it)
and pass `context: { user: auth.user, token }` so both transports present the identical
context shape. Update `RpcHandlerLike`-equivalent typing notes if needed.

**Confidence:** High.

---

## BUG-9 — Early HTTP-upload reject doesn't drain/destroy the request stream

- **Severity:** Low. **Likelihood:** Medium for consumers using `beforeUpload` as the
  size/content-type gate it was built to be.
- **Location:** `packages/orpc-ws-server/src/upload/http-handler.ts:224-255` (the
  pre-`handle()` reject paths) + `sendError` at 217-222.

**The bug.** When `verifyClient` or `beforeUpload` rejects, the handler writes the error
response and returns while the client may still be streaming a large multipart body. The
request stream is never consumed, resumed, or destroyed. Consequences: the keep-alive
connection cannot be reused (Node must tear it down after the unread body), some clients
don't process the early response until they finish uploading the entire body, and the
"never buffered" promise of the early gate (comments at 241-244) doesn't stop the bytes
from being *transmitted* — the bandwidth is still spent. This is the standard
multer/busboy early-abort pitfall.

**Existing coverage:** `before-upload-hook.test.ts` asserts the response code, not socket
behavior. (The repo's own commit `1496f2a` notes the absent-hook test artifact uses fake
reqs — real-socket behavior untested.)

**Proposed fix.** On every pre-`handle()` reject: set `Connection: close` on the
response, then either `req.resume()` (drain and discard) for small bodies or
`res.once('finish', () => req.destroy())` for large ones. Pick one policy and document it.

**Confidence:** Medium (severity depends on client/proxy behavior; the missing handling
itself is certain).

---

## BUG-10 — Sleep-detector Blob URL never revoked (and the comment misstates the cost)

- **Severity:** Low. **Likelihood:** Low.
- **Location:** `packages/orpc-ws-client/src/sleep/worker-source.ts:56-66`;
  `packages/orpc-ws-client/src/sleep/sleep-detector.ts:201-245` (`start()`/`stop()` —
  `stop()` terminates the worker but the object URL persists).

**The bug.** `defaultWorkerFactory` calls `URL.createObjectURL` per invocation and never
revokes. The in-code justification — "one URL entry per detector *instance*" — is wrong:
it's one per `start()` call, and `SleepDetector.start()/stop()` are explicitly designed
to cycle ("After `stop()` the detector can be restarted with `start()`, which creates a
fresh worker"). Today the composition root only starts it once (`index.ts:537-539`), so
the leak is bounded; any future start/stop cycling (e.g. pausing detection on `kicked`)
would leak a blob per cycle.

**Proposed fix.** Revoke after the worker boots — the safe portable pattern is
`worker.addEventListener('message', () => URL.revokeObjectURL(url), { once: true })`
(first tick proves the script loaded), or track the URL and revoke in a
`terminate()`-wrapping factory handle. Fix the comment either way.

**Confidence:** High on the facts; Low impact.

---

## Needs further investigation

These are plausible but either depend on upstream behavior I could not verify
review-only, or are explicit design-cut questions for the maintainer.

1. **Heartbeat stream failing before `config` leaves the connection unmonitored.**
   `subscriber.ts:232-245` logs a stream error and stops; if the error happens before the
   `config` event (e.g. `link.call` rejects, or the server-side procedure errors while the
   WS stays open), the monitor is never configured (`monitor.ts:161-169` no-ops on
   `start()` without configure) and the watchdog never arms. No retry of the
   subscription exists; a later half-open zombie goes undetected. Whether ORPC can fail
   the heartbeat call while keeping the WS healthy needs an integration probe.
2. **`willRetry: true` can lie when `maxRetries` is finite.**
   `event-handlers.ts:240-249` asserts `willRetry: true` on every normal disconnect; with
   a consumer-configured finite `maxRetries`, partysocket eventually stops retrying while
   the state forever claims it will. Default config is `Infinity`, so stock setups are
   unaffected.
3. **HTTP-upload 401 is not wired into the auth-recovery/storm-guard machinery**, though
   CLAUDE.md's locked storm-guard decision lists "HTTP-upload 401" as one of the triggers
   of the single window. `orpc-http-strategy.ts:143-153` just rethrows to the caller; no
   refresh attempt, no terminal signal. If this is a deliberate v1 cut it should be
   recorded; otherwise it's a missing feature of the locked design.
4. **Server `dispose()` can hang up to `ws`'s 30 s close-handshake timeout per dead
   client.** `index.ts:425-446` + `connection-registry.ts:164-174` use `close()` (clean
   handshake) and then await `wss.close()`, which waits for clients to finish closing. A
   dead client delays shutdown until the `ws` library's internal close timer terminates
   it. Consider a bounded terminate-fallback.
5. **`reconnect()`'s mutex drop can discard the only recovery signal.**
   `reconnect-manager.ts:258-264`: a `reconnect()` arriving while another is in flight
   resolves immediately without any reconnect occurring after it. Combined with BUG-4's
   latch this can drop a legitimate trigger permanently. Verbatim source semantics, but
   worth revisiting once BUG-4 is fixed (e.g. queue one trailing rerun).

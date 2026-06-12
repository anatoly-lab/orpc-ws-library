# `@orpc-ws/server` — Test scope (Phase 4)

This note clarifies what the **library** test suite covers vs. what is
explicitly **consumer-owned** and intentionally NOT tested in the library.

## Library-owned tests (in `@orpc-ws/server`)

The server-core test suite covers the transport layer:

- **Connection lifecycle** — `verifyClient` → `'connection'` → registry
  → `rpcHandler.upgrade()` → `ws.on('close')`, in the sync ordering
  required by Bug 5 (`connection-flow.test.ts`).
- **Connection registry** — atomic delete-if-same (Bug 9 server side),
  session replacement with `singleConnectionPerUser`
  (`connection-registry.test.ts`).
- **Heartbeat publisher** — config-event-first contract, ping cadence,
  N-subscriber fan-out, abort handling, **single timer regardless of
  subscriber count** (`publisher.test.ts` + `publisher-fanout.test.ts`).
- **WS-protocol ping/pong watchdog** — alive flip on pong, zombie
  detection on missed pong, `onZombieTerminated` hook, opt-out switch
  (`ws-ping-pong.test.ts`).
- **Bug 6 keepalive** — real `ws` client over 5 ping intervals stays
  open; non-ponging client gets terminated
  (`integration/bug-06-keepalive.test.ts`).
- **Dispose ordering** — graceful close code 4009 delivered to every
  connected client before TCP teardown; idempotent; post-dispose
  upgrade attempts fail (`integration/dispose-ordering.test.ts`).
- **Lifecycle hooks** — `onConnected`, `onDisconnected`, `onKicked`,
  `onZombieTerminated` fire with correctly typed payloads
  (`integration/hooks.test.ts`).
- **Router composition** — eager collision check on the
  `__orpc_ws_lib__` namespace at constructor time
  (`router-composer.test.ts`).
- **Pre-101 auth orchestration** — discriminated-union result mapping,
  WeakMap req→auth bridging (`verify-client-orchestrator.test.ts`).

## Explicitly NOT tested (consumer-owned)

These belong to the consumer's domain. Adding library tests for them
would either duplicate the consumer's own coverage or, worse, lock the
library to a specific consumer choice.

- **`azp` claim verification** — the consumer's `verifyClient` callback
  is responsible for inspecting JWT claims (`azp`, `iss`, `aud`, custom
  scopes). The library only orchestrates the callback's success / fail
  result. Consumer tests their JWT verification in their own auth suite.
- **`metricsMiddleware`** — when a consumer wraps procedures in an ORPC
  `os.use(metricsMiddleware)` chain, the library does not see it. The
  middleware is the consumer's ORPC code; their procedure tests cover it.
- **`EventBusService` fanout** — fan-out of domain events to subscribed
  clients lives in a consumer-owned ORPC procedure (e.g.,
  `events.subscribe`). The library only carries the bytes; the
  procedure's behavior (filtering, authorization-per-channel, etc.) is
  tested by the consumer.

The line is: **library tests focus on the transport.** Anything the
consumer plugs IN (verifier, middleware, procedures) is tested where it
lives — in the consumer's repo.

## E2E (Phase 7) — explicitly out of scope here

Phase 4 (this PR) does NOT cover the real-infrastructure failures:

- Real K8s / Traefik / nginx idle-timeout drop (Bug 6 production cause)
- Real device sleep across tab inactivation (Bug 11)
- Real cross-tab token revoke + reconnect (Bug 1)

Those need Playwright + a real proxy / real timers and live in
`tests-e2e/` (Phase 7). The Phase 4 keepalive test pins the
**mitigation mechanic** (ping/pong frames flow on loopback); Phase 7
pins the **real failure mode** behind a proxy.

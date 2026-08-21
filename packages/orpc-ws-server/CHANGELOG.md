# @orpc-ws/server

## 0.13.0

### Patch Changes

- @orpc-ws/shared@0.13.0

## 0.12.3

### Patch Changes

- chore: build with TypeScript 7 (Go-native compiler). Shipped declarations verified byte-identical to the TS 6 build — no public API or behavior changes.
- Updated dependencies
  - @orpc-ws/shared@0.12.3

## 0.12.2

### Patch Changes

- chore: migrate lint tooling from ESLint to Biome (type-import style normalization only — no public API or behavior changes)
- Updated dependencies
  - @orpc-ws/shared@0.12.2

## 0.12.1

### Patch Changes

- chore: upgrade dependencies (no public API changes)
- Updated dependencies
  - @orpc-ws/shared@0.12.1

## 0.12.0

### Minor Changes

- BREAKING: `@orpc/client`, `@orpc/contract`, and `@orpc/server` are now peerDependencies (range `>=1.14.8 <2`) instead of dependencies. Consumers must declare these `@orpc/*` packages as direct dependencies at `>=1.14.8 <2`. This prevents two @orpc copies in one process — ORPC's version-keyed cross-copy `instanceof` shim would otherwise degrade typed ORPCErrors to a generic "Internal server error" when the consumer's @orpc version differs from the library's.

### Patch Changes

- Updated dependencies
  - @orpc-ws/shared@0.12.0

## 0.11.1

### Patch Changes

- chore: upgrade dependencies (no public API changes)
- Updated dependencies
  - @orpc-ws/shared@0.11.1

## 0.11.0

### Patch Changes

- @orpc-ws/shared@0.11.0

## 0.10.0

### Minor Changes

- 63d12e8: Two hardening changes (user-approved 2026-07-02):

  - **Heartbeat subscriptions are now last-wins per connection.** One socket could previously open unbounded heartbeat streams (each allocating server-side machinery freed only at disconnect — an unauthenticated memory-growth vector on authless servers). Now a new heartbeat subscription on the same connection gracefully ends the previous one, strictly bounding it at 1 per connection. The library's own client always aborts before resubscribing, so legitimate clients are unaffected. `subscriberCount()` now reports the true live-subscriber count (it previously counted distinct event names — always 0 or 1).
  - **New `verifyTimeoutMs` option (default 30000, `0` or negative disables).** A consumer `verifyClient` promise that never settles (e.g. a stuck JWKS fetch with no timeout of its own) previously pinned the pending upgrade socket forever. The verify is now raced against a deadline on the injected `Clock`; on timeout the upgrade fails closed (pre-101 HTTP 500) and the late settlement is ignored. Not applicable to authless mode. `DEFAULT_VERIFY_TIMEOUT_MS` is exported.

### Patch Changes

- 80b5a72: Low-severity hardening batch:

  - **client**: `upload()` now rejects before any I/O once the client is dead (disposed, terminal auth failure, or kicked) — previously a post-`dispose()` upload performed a real network call and could emit events. The bidi handle is now retired on terminal/kicked paths (was: only on `dispose()`, a memory retention). New public `LinkNotReadyError` typed error thrown by the link factory when the socket isn't open. Heartbeat subscriber no longer retains the last loop's closure.
  - **react**: `useWsSubscription` classifies `LinkNotReadyError` as transient — the narrow drop-between-render-and-subscribe race no longer flashes `status: "error"`; it self-heals silently on reconnect.
  - **server**: upload HTTP handler reuses the shared client-IP extraction (fixing an X-Forwarded-For empty-first-hop drift with the WS path) and restores `req.url`/`req.originalUrl` before delegating unmatched requests via `next()`. The shared verify-result guard now also rejects `{ok: true, user: undefined}` (both transports).
  - **oidc-verifier-jose**: `jwtVerify` now pins an explicit `algorithms` allowlist. **Default-pinning behavior change**: the default set is the asymmetric algorithms `RS256/384/512, ES256/384/512, PS256/384/512, EdDSA` — symmetric (`HS*`) tokens are now rejected before key resolution (RS→HS key-confusion defense). If your IdP signs with an algorithm outside this set, pass `algorithms: [...]` explicitly. New `clockTolerance` option (exp/nbf skew), off by default.

- ac70eb7: Harden the connection path against synchronous throws (fail closed instead of crashing):

  - A `verifyClient` that throws synchronously (or returns a non-promise) no longer escapes the `ws` upgrade path — in authless mode a sync handler throw was a genuine `uncaughtException` (process crash, triggerable by a single bad frame/token); in authed mode the error was swallowed with a misleading log and double-fired the ws callback, writing a raw `HTTP/1.1 500` onto the already-upgraded socket. Both now fail closed (500 reject / 1011 close) with truthful logging.
  - A synchronous throw in the connection handler after registry registration no longer leaks the registry entry: wiring failures roll back (unregister first — unskippable — then timer/ping-pong/bidi teardown) and the socket is closed 1011. The next connection under the same key, including the authless single-connection constant key, proceeds normally.

- 4782cab: The WS verify path is now fail-closed on malformed `verifyClient` results, mirroring the HTTP upload transport's existing hardening (shared `isWellFormedAuthResult`, extracted so the two transports cannot drift). Previously a contract-violating verifier resolving `{ok: "yes"}` or `{ok: true}` without a `user` was accepted — connections got registered under a literal-`undefined` key (colliding/kicking each other) and procedures ran with `context.user === undefined`. A failure result missing `code`/`reason` also no longer reaches `ws` internals (which threw a `TypeError` on the missing reason); all malformed shapes now reject the upgrade with a clean 500.
  - @orpc-ws/shared@0.10.0

## 0.9.0

### Minor Changes

- 654a03d: Flip the authless server default from "connections coexist" to a single global
  connection where a new connection kicks the previous.

  Previously, `createAuthlessOrpcWsServer` gave every anonymous socket a unique
  registry key, so connections coexisted and none ever kicked another. The new
  default is single-session: all authless sockets share one registry key, so a
  NEW connection replaces the previous one — the prior socket is closed with
  `4005` (session-replaced) and the library client maps `4005` to the terminal
  `kicked` state (it does not reconnect). This models a single-GUI remote-control
  server where the newest tab takes over.

  - **Opt-out to restore the old behavior:** set `allowConcurrentConnections:
true` (new option on `AuthlessOrpcWsServerOptions`, default `false`). Each
    connection then gets a unique key, nothing is kicked, and any number of
    anonymous clients coexist freely — `onKicked` never fires.
  - **`AuthlessHooks` gained a user-less `onKicked?: (replacedBy: WebSocket) =>
void`.** It carries only the replacing WebSocket (authless has no principal,
    so no kicked `user`) and fires in the default single-connection mode when a
    new connection replaces the previous; it never fires under
    `allowConcurrentConnections: true`.
  - **NestJS:** `OrpcWsModule.forRoot/forRootAsync({ mode: "authless", … })`
    inherits `allowConcurrentConnections` and the authless `onKicked` through the
    option type.

  **BREAKING for existing authless consumers who relied on coexisting
  connections:** under the new default a second authless connection now kicks the
  first. Pass `allowConcurrentConnections: true` to keep the old coexist behavior.

### Patch Changes

- @orpc-ws/shared@0.9.0

## 0.8.0

### Minor Changes

- b93dd3d: Add server→client RPC over WebSocket (bidirectional).

  A server can now invoke procedures hosted on the client over the existing WS
  connection, alongside normal client→server RPC and heartbeat on a single
  socket. Fully opt-in — omitting `clientContract` / `clientRouter` is
  byte-identical to the prior one-way behavior.

  - **server**: `createOrpcWsServer` / `createAuthlessOrpcWsServer` gain a third
    generic `TClientContract` + a `clientContract` option. When supplied,
    `conn.client.<proc>()` invokes a procedure hosted on that connection's
    client, and `server.getConnection(key)` retrieves a live connection. Two
    logical channels (client→server, server→client) share one socket via frame
    tagging.
  - **client**: `createOrpcWsClient` gains `clientRouter` / `clientContext` to
    host a router the server calls. New public `createDelegatingClientRouter`
    helper builds an identity-stable router whose leaves delegate to a live
    handler map (the late-binding bridge used by the React adapter).
  - **react**: new `<OrpcWs>` construct-and-own provider — takes the server→client
    `clientContract` VALUE (`oc.router({ … })`; bidi on iff present,
    `TClientContract` inferred — no explicit generic), builds the client once,
    owns connect/dispose (StrictMode-safe), and renders `OrpcWsProvider` underneath
    so `useConnectionState` / `useWsSubscription` / `useOrpcWs` keep working below
    it. Feature-local handler implementations register from any descendant via
    `createServerHandlerHook<TClientContract>()` → a typed `useServerHandler(name,
fn)` (the closure may close over hooks/state, so a server push mutates live
    React UI).
  - **nestjs**: `OrpcWsModule.forRoot` / `forRootAsync` thread `clientContract` +
    the third generic; `OrpcWsService.getConnection`. Note: a `forRootAsync`
    `useFactory` must annotate its return type
    (`(): OrpcWsModuleOptions<…, …, MyClientContract> => …`) or `TClientContract`
    silently collapses to `never` and `conn.client` disappears.

  **BREAKING (`@orpc-ws/server`, `@orpc-ws/server-nestjs`):** the lifecycle hooks
  changed to a single connection object — `onConnected(conn)` /
  `onDisconnected(conn, code)` (previously `onConnected(user, ws)` /
  `onDisconnected(user, ws, code)`). Update hook signatures accordingly.

### Patch Changes

- Updated dependencies [b93dd3d]
  - @orpc-ws/shared@0.8.0

## 0.7.0

### Patch Changes

- @orpc-ws/shared@0.7.0

## 0.6.1

### Patch Changes

- @orpc-ws/shared@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [ef68d30]
  - @orpc-ws/shared@0.6.0

## 0.5.0

### Patch Changes

- @orpc-ws/shared@0.5.0

## 0.4.0

### Patch Changes

- @orpc-ws/shared@0.4.0

## 0.3.0

### Minor Changes

- d02786d: Expose ORPC `RPCHandler` interceptors as a passthrough on the server options:
  new optional `interceptors` and `rootInterceptors` fields, forwarded to BOTH
  internally-built RPCHandlers (the WS handler and the optional HTTP upload
  handler).

  The common use is a single central error logger that covers EVERY procedure
  regardless of how the consumer composed their router — including sub-routers
  that were spread in unwrapped (e.g. `...authRouter.getRouter()`), which
  previously bypassed consumer root middleware and so were never server-logged:

  ```ts
  import { onError } from "@orpc/server";

  createOrpcWsServer({
    router,
    verifyClient,
    interceptors: [onError((e) => logger.error({ err: e }, "orpc error"))],
  });
  ```

  Available on both factories (`createOrpcWsServer` / `createAuthlessOrpcWsServer`)
  and on both arms of the NestJS `OrpcWsModuleOptions`.

  Coverage caveats (intentional): `interceptors` fires for unary procedure
  failures and AsyncIterable subscription _setup_ failures, but does NOT see
  errors thrown mid-stream from an AsyncIterable (the handle has already
  resolved), nor the HTTP upload transport's pre-ORPC rejects (verifyClient /
  beforeUpload reject before the RPCHandler runs). `rootInterceptors` wrap the
  whole handle including ORPC's error→response mapping, so a `rootInterceptor`
  `onError` will NOT fire on a procedure throw — use `interceptors` for that.

### Patch Changes

- @orpc-ws/shared@0.3.0

## 0.2.1

### Patch Changes

- @orpc-ws/shared@0.2.1

## 0.2.0

### Minor Changes

- f6a8a17: Add a first-class authless server mode. `createAuthlessOrpcWsServer({ router })`
  (core) and `OrpcWsModule.forRoot/forRootAsync({ mode: "authless", router })`
  (NestJS) start the server with no client verification: every WebSocket upgrade
  is accepted, procedures run with an empty ORPC context (no `user`/`token`), and
  each connection gets a unique key so single-session enforcement is off (no
  `4005`). Authless servers expose no uploads, no token-expiry, and no
  `closeUser`. The authenticated path is unchanged — `createOrpcWsServer({ router,
verifyClient })` is the new explicit factory name for it (the `OrpcWsServer`
  class remains the advanced/internal entry).

### Patch Changes

- @orpc-ws/shared@0.2.0

## 0.1.2

### Patch Changes

- @orpc-ws/shared@0.1.2

# @orpc-ws/client

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

- 80b5a72: Low-severity hardening batch:

  - **client**: `upload()` now rejects before any I/O once the client is dead (disposed, terminal auth failure, or kicked) — previously a post-`dispose()` upload performed a real network call and could emit events. The bidi handle is now retired on terminal/kicked paths (was: only on `dispose()`, a memory retention). New public `LinkNotReadyError` typed error thrown by the link factory when the socket isn't open. Heartbeat subscriber no longer retains the last loop's closure.
  - **react**: `useWsSubscription` classifies `LinkNotReadyError` as transient — the narrow drop-between-render-and-subscribe race no longer flashes `status: "error"`; it self-heals silently on reconnect.
  - **server**: upload HTTP handler reuses the shared client-IP extraction (fixing an X-Forwarded-For empty-first-hop drift with the WS path) and restores `req.url`/`req.originalUrl` before delegating unmatched requests via `next()`. The shared verify-result guard now also rejects `{ok: true, user: undefined}` (both transports).
  - **oidc-verifier-jose**: `jwtVerify` now pins an explicit `algorithms` allowlist. **Default-pinning behavior change**: the default set is the asymmetric algorithms `RS256/384/512, ES256/384/512, PS256/384/512, EdDSA` — symmetric (`HS*`) tokens are now rejected before key resolution (RS→HS key-confusion defense). If your IdP signs with an algorithm outside this set, pass `algorithms: [...]` explicitly. New `clockTolerance` option (exp/nbf skew), off by default.

### Patch Changes

- 3c4ec86: A server that is merely down no longer forces a logout (token mode). Pre-open connection failures — which the browser cannot distinguish from handshake rejections — now trip the storm guard to _keep retrying with the current token_ (riding the reconnect backoff, one token refresh per 30s window) instead of firing `onTerminalAuthFailure` within ~30s of downtime. Give-up stays auth-owned: a failed/null refresh, a real post-accept auth close (1008/4001), or an upload 401 still goes terminal. Corollary (documented): a handshake-time rejection by the server is indistinguishable from downtime in the browser and also retries — servers wanting a hard client give-up must reject after accepting (1008/4001 close).
- 1bbe790: Fix a critical reconnect bug cluster around `swapSocket`'s synchronous close (Bugs 21–24):

  - `swapSocket` now follows the CLEAR-BEFORE-CLOSE discipline. partysocket ≥1.2 dispatches `close()` synchronously, so the old wrapper's synthetic pre-open close-1000 was processed as a real close → auth-recovery → storm-guard trip → spurious terminal logout after a _successful_ token refresh (cookie mode: force-logout on a routine sleep-wake).
  - `swapSocket` re-checks `isDead()` after the close so a terminal fired mid-swap can no longer resurrect a zombie socket that flips state back to `connected`.
  - A pre-open close 1000 carrying partysocket's connection-timeout reason (`"timeout"`) is now classified as a normal retryable disconnect instead of an auth failure.
  - The auth-recovery decision carries its provenance (`"auth-close"` vs `"pre-open-1000"`); with no `tokenProvider` (cookie auth), a pre-open network failure is now a benign no-op — only a real auth-failure close (1008/4001) goes terminal, restoring the documented cookie-auth contract.
  - @orpc-ws/shared@0.10.0

## 0.9.0

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

### Patch Changes

- @orpc-ws/shared@0.3.0

## 0.2.1

### Patch Changes

- @orpc-ws/shared@0.2.1

## 0.2.0

### Patch Changes

- @orpc-ws/shared@0.2.0

## 0.1.2

### Patch Changes

- 9e44221: Fix heartbeat teardown under partysocket 1.2.0. Terminal teardown (`dispose()`, terminal auth failure, and session-replace/kick) no longer emits a spurious `auth_failure{refreshable:true}` or a transient `disconnected{willRetry:true}` frame before the terminal state, and no longer surfaces an unhandled WebSocket "not open" error during teardown. The heartbeat subscriber's stop is now split into `abort()` (open-socket) vs `drop()` (closed-socket, letting orpc's own close-listener clean up framelessly), driven by the lifecycle layer.

  Also refreshes the underlying dependencies across the `@orpc-ws/*` family: `@orpc/*` → 1.14.6 and `partysocket` → 1.2.0.

  - @orpc-ws/shared@0.1.2

# @orpc-ws/react

## 0.10.0

### Minor Changes

- 8a8c2b0: React adapter fixes for reconnect blips and stream lifecycle:

  - `<OrpcWs>`'s `fallback` now latches after the first successful connect: children stay mounted through reconnect blips (previously every disconnect unmounted the whole subtree, losing component state, unregistering `useServerHandler` handlers, and resetting subscriptions). Observe blips via `useConnectionState`.
  - `useWsSubscription` gains a `"completed"` status: a finite stream ending gracefully is now observable instead of leaving `status` stuck at `"active"` forever. Sticky until the next reconnect cycle or `enabled` toggle.
  - `useWsSubscription` hardening: a late event racing teardown can no longer corrupt `status` or reach a disabled consumer (abort guard in `onEvent`), and a rejecting iterator `return()` during teardown no longer escapes as an unhandled rejection.

### Patch Changes

- 80b5a72: Low-severity hardening batch:

  - **client**: `upload()` now rejects before any I/O once the client is dead (disposed, terminal auth failure, or kicked) — previously a post-`dispose()` upload performed a real network call and could emit events. The bidi handle is now retired on terminal/kicked paths (was: only on `dispose()`, a memory retention). New public `LinkNotReadyError` typed error thrown by the link factory when the socket isn't open. Heartbeat subscriber no longer retains the last loop's closure.
  - **react**: `useWsSubscription` classifies `LinkNotReadyError` as transient — the narrow drop-between-render-and-subscribe race no longer flashes `status: "error"`; it self-heals silently on reconnect.
  - **server**: upload HTTP handler reuses the shared client-IP extraction (fixing an X-Forwarded-For empty-first-hop drift with the WS path) and restores `req.url`/`req.originalUrl` before delegating unmatched requests via `next()`. The shared verify-result guard now also rejects `{ok: true, user: undefined}` (both transports).
  - **oidc-verifier-jose**: `jwtVerify` now pins an explicit `algorithms` allowlist. **Default-pinning behavior change**: the default set is the asymmetric algorithms `RS256/384/512, ES256/384/512, PS256/384/512, EdDSA` — symmetric (`HS*`) tokens are now rejected before key resolution (RS→HS key-confusion defense). If your IdP signs with an algorithm outside this set, pass `algorithms: [...]` explicitly. New `clockTolerance` option (exp/nbf skew), off by default.

- Updated dependencies [3c4ec86]
- Updated dependencies [1bbe790]
- Updated dependencies [80b5a72]
  - @orpc-ws/client@0.10.0

## 0.9.0

### Patch Changes

- @orpc-ws/client@0.9.0

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
  - @orpc-ws/client@0.8.0

## 0.7.0

### Patch Changes

- @orpc-ws/client@0.7.0

## 0.6.1

### Patch Changes

- @orpc-ws/client@0.6.1

## 0.6.0

### Patch Changes

- @orpc-ws/client@0.6.0

## 0.5.0

### Patch Changes

- @orpc-ws/client@0.5.0

## 0.4.0

### Patch Changes

- @orpc-ws/client@0.4.0

## 0.3.0

### Patch Changes

- @orpc-ws/client@0.3.0

## 0.2.1

### Patch Changes

- Republish to fix a broken `@orpc-ws/react@0.2.0` manifest. In 0.2.0 the
  package's `@orpc-ws/client` dependency was published as the literal pnpm
  `workspace:*` protocol spec instead of the resolved exact version, because that
  one package was bootstrapped (first-ever publish) with `npm publish` — and
  `npm` does not understand or rewrite the pnpm `workspace:*` protocol, so it
  shipped the string verbatim (an invalid range on the npm registry). 0.2.1 is
  published via `pnpm -r publish`, which rewrites `workspace:*` to the exact
  version. Consumers on `@orpc-ws/react@0.2.0` should upgrade to 0.2.1.
  - @orpc-ws/client@0.2.1

## 0.2.0

### Minor Changes

- c7da1fe: Extract WebSocket-transport React hooks (`useConnectionState`, `useWsSubscription`, `OrpcWsProvider`, `useOrpcWs`) into a new `@orpc-ws/react` package that depends only on `@orpc-ws/client`. `@orpc-ws/oidc-react` now hosts OIDC auth bindings only and no longer depends on `@orpc-ws/client`; import the WS hooks from `@orpc-ws/react` instead.

### Patch Changes

- @orpc-ws/client@0.2.0

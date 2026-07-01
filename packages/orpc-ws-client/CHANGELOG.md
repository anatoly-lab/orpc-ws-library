# @orpc-ws/client

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

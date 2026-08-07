# @orpc-ws/shared

## 0.12.1

### Patch Changes

- chore: upgrade dependencies (no public API changes)

## 0.12.0

### Minor Changes

- BREAKING: `@orpc/client`, `@orpc/contract`, and `@orpc/server` are now peerDependencies (range `>=1.14.8 <2`) instead of dependencies. Consumers must declare these `@orpc/*` packages as direct dependencies at `>=1.14.8 <2`. This prevents two @orpc copies in one process — ORPC's version-keyed cross-copy `instanceof` shim would otherwise degrade typed ORPCErrors to a generic "Internal server error" when the consumer's @orpc version differs from the library's.

## 0.11.1

### Patch Changes

- chore: upgrade dependencies (no public API changes)

## 0.11.0

## 0.10.0

## 0.9.0

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

## 0.7.0

## 0.6.1

## 0.6.0

### Minor Changes

- ef68d30: Remove the browser-PKCE / localStorage auth topology. `@orpc-ws/oidc-pkce` (browser PKCE core) and `@orpc-ws/oidc-react` (its React hooks adapter) are deleted from the library and deprecated on npm. Browsers should authenticate via cookie-BFF (`@orpc-ws/cookie-bff`, `-nestjs`, `-client`); native/mobile/service clients send a Bearer token over the WS and verify it server-side with `@orpc-ws/oidc-verifier-jose` (kept for exactly this path). `@orpc-ws/react` is now the sole React adapter. The `apps/demo-pkce` app was removed and the Playwright e2e suite was repointed to the cookie-BFF demo. No source-level API change to any retained package — this is a topology/packaging change (the lockstep bump keeps the 9 retained packages in version sync).

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.1

## 0.2.0

## 0.1.2

# @orpc-ws/server-nestjs

## 0.11.1

### Patch Changes

- chore: upgrade dependencies (no public API changes)
- Updated dependencies
  - @orpc-ws/shared@0.11.1
  - @orpc-ws/server@0.11.1

## 0.11.0

### Patch Changes

- @orpc-ws/shared@0.11.0
- @orpc-ws/server@0.11.0

## 0.10.0

### Patch Changes

- 074e1ae: Upload-route safety and comment truthfulness in the NestJS adapter:

  - New boot-time detection: a consumer controller route nested under the upload `httpPath` (e.g. `@Controller("upload")` + `@Post("media/upload")`) now logs a warning naming the offending route — on Nest 11 controllers register before the upload middleware, so such routes silently shadowed RPC upload procedures. Warn, not throw: apps booting with this misconfiguration today keep booting. The exact-path collision still throws as before.
  - The `onModuleInit` registration rationale was rewritten to the true Nest 11 mechanism (controllers register _before_ the middleware; it works because the 404 catch-all registers _after_), and the false claim that `closeUser` no-ops on an authless server was corrected (it kicks by registry key in any mode; the authless `Omit` is compile-time only).

- Updated dependencies [80b5a72]
- Updated dependencies [63d12e8]
- Updated dependencies [ac70eb7]
- Updated dependencies [4782cab]
  - @orpc-ws/server@0.10.0
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

- Updated dependencies [654a03d]
  - @orpc-ws/server@0.9.0
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
  - @orpc-ws/server@0.8.0

## 0.7.0

### Patch Changes

- @orpc-ws/shared@0.7.0
- @orpc-ws/server@0.7.0

## 0.6.1

### Patch Changes

- @orpc-ws/shared@0.6.1
- @orpc-ws/server@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [ef68d30]
  - @orpc-ws/shared@0.6.0
  - @orpc-ws/server@0.6.0

## 0.5.0

### Patch Changes

- @orpc-ws/shared@0.5.0
- @orpc-ws/server@0.5.0

## 0.4.0

### Patch Changes

- @orpc-ws/shared@0.4.0
- @orpc-ws/server@0.4.0

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

- Updated dependencies [d02786d]
  - @orpc-ws/server@0.3.0
  - @orpc-ws/shared@0.3.0

## 0.2.1

### Patch Changes

- @orpc-ws/shared@0.2.1
- @orpc-ws/server@0.2.1

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

- Updated dependencies [f6a8a17]
  - @orpc-ws/server@0.2.0
  - @orpc-ws/shared@0.2.0

## 0.1.2

### Patch Changes

- @orpc-ws/shared@0.1.2
- @orpc-ws/server@0.1.2

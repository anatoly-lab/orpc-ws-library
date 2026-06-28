# @orpc-ws/server

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

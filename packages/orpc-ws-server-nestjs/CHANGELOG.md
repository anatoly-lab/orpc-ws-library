# @orpc-ws/server-nestjs

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

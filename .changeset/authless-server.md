---
"@orpc-ws/server": minor
"@orpc-ws/server-nestjs": minor
---

Add a first-class authless server mode. `createAuthlessOrpcWsServer({ router })`
(core) and `OrpcWsModule.forRoot/forRootAsync({ mode: "authless", router })`
(NestJS) start the server with no client verification: every WebSocket upgrade
is accepted, procedures run with an empty ORPC context (no `user`/`token`), and
each connection gets a unique key so single-session enforcement is off (no
`4005`). Authless servers expose no uploads, no token-expiry, and no
`closeUser`. The authenticated path is unchanged — `createOrpcWsServer({ router,
verifyClient })` is the new explicit factory name for it (the `OrpcWsServer`
class remains the advanced/internal entry).

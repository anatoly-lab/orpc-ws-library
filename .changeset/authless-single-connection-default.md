---
"@orpc-ws/server": minor
"@orpc-ws/server-nestjs": minor
---

Flip the authless server default from "connections coexist" to a single global
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

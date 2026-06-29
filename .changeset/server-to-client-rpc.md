---
"@orpc-ws/shared": minor
"@orpc-ws/client": minor
"@orpc-ws/server": minor
"@orpc-ws/server-nestjs": minor
"@orpc-ws/react": minor
---

Add server→client RPC over WebSocket (bidirectional).

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
- **react**: new `<OrpcWs>` construct-and-own provider — hosts a React-aware
  `clientRouter` whose flat handler map may close over hooks/state (so a server
  push mutates live React UI). Builds the client once, owns connect/dispose
  (StrictMode-safe), and renders `OrpcWsProvider` underneath so
  `useConnectionState` / `useWsSubscription` / `useOrpcWs` keep working below
  it.
- **nestjs**: `OrpcWsModule.forRoot` / `forRootAsync` thread `clientContract` +
  the third generic; `OrpcWsService.getConnection`. Note: a `forRootAsync`
  `useFactory` must annotate its return type
  (`(): OrpcWsModuleOptions<…, …, MyClientContract> => …`) or `TClientContract`
  silently collapses to `never` and `conn.client` disappears.

**BREAKING (`@orpc-ws/server`, `@orpc-ws/server-nestjs`):** the lifecycle hooks
changed to a single connection object — `onConnected(conn)` /
`onDisconnected(conn, code)` (previously `onConnected(user, ws)` /
`onDisconnected(user, ws, code)`). Update hook signatures accordingly.

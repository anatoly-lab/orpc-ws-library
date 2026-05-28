# `@repo/orpc-ws-server`

Framework-free ORPC-over-WebSocket server core. Vanilla Node + [`ws`] +
[`@orpc/server`]. The composition root (`OrpcWsServer`) attaches to a
plain `http.Server`; no `@nestjs/*`, no `express`, no `fastify`. On
NestJS, use [`@repo/orpc-ws-server-nestjs`](../orpc-ws-server-nestjs)
instead — it wraps this core in Nest's lifecycle.

## Install

```bash
npm install @repo/orpc-ws-server
```

`ws` and `@orpc/server` are direct dependencies. You bring your own
`http.Server`.

## Quickstart

```ts
import { createServer } from "http";
import { OrpcWsServer } from "@repo/orpc-ws-server";
import type { VerifyClientContext } from "@repo/orpc-ws-server";
import { os } from "@orpc/server";

// 1. Your ORPC router. Whatever shape you already have.
const appRouter = {
  todos: { list: os.handler(async () => [{ id: 1, title: "ship the lib" }]) },
};

// 2. Pre-101 auth. Discriminated union — see below for why.
const verifyClient = async (ctx: VerifyClientContext) => {
  const token = new URL(ctx.req.url ?? "", "http://x").searchParams.get("token");
  const user = await myAuthService.verifyToken(token);
  if (!user) return { ok: false, code: 4001, reason: "Unauthorized" };
  return { ok: true, user, connectionKey: user.id };
};

// 3. Compose, attach, listen.
const httpServer = createServer();
const wsServer = new OrpcWsServer({
  router: appRouter,
  verifyClient,
  // Optional knobs (all have sensible defaults):
  // connection: { path: "/ws", shutdownCloseCode: 4009 },
  // heartbeat:  { intervalMs: 25_000, timeoutMs: 20_000 },
  // hooks:      { onConnected: (u, ws) => ..., onKicked: ... },
});
wsServer.attach(httpServer);
httpServer.listen(3000);

// On shutdown:
//   await wsServer.dispose();
//   httpServer.close();
```

## `verifyClient`

```ts
type VerifyClientResult<TUser> =
  | { ok: true; user: TUser; connectionKey?: string }
  | { ok: false; code: number; reason: string };
```

Returns `{ok, code, reason}` not exceptions — `verifyClient` runs
inside `ws`'s upgrade callback, **before** any framework request
pipeline exists, so there's no exception filter to translate thrown
errors. Typical codes: `4001` (auth failed), `4009` (server shutdown).

`connectionKey` is the registry key for "this user." The registry uses
it for single-connection-per-user enforcement (close 4005 to the older
socket) and for `closeUser()` lookups. Usually the user's `sub` claim,
but any stable string works. Omitting it disables both features for
that connection.

## OIDC verifier

For OIDC against any spec-compliant IdP (Keycloak, Auth0, Okta,
Cognito, Google), drop in
[`@repo/oidc-verifier-jose`](../oidc-verifier-jose/README.md):

```ts
import { createOidcVerifyClient } from "@repo/oidc-verifier-jose";

const verifyClient = createOidcVerifyClient({
  issuerUrl: process.env.OIDC_ISSUER_URL!,
  boundClaim: "azp",                              // see verifier README
  expectedClientId: process.env.OIDC_CLIENT_ID!,
});
```

The verifier handles JWKS fetching, bound-claim checks, and derives
`connectionKey` from the verified `sub` independent of `mapUser`.

## Heartbeat

Library owns heartbeat via two independent paths:

1. **ORPC stealth procedure** at `__orpc_ws_lib__.heartbeat` — server
   publishes `config` + `ping` events, client subscribes via
   `link.call`, feeds a watchdog. Catches application-layer stalls.
2. **WS-protocol ping/pong** — kernel-level dead-socket detection.
   Missing two pongs → terminate.

The library reserves the `__orpc_ws_lib__` namespace and asserts no
collision in your router at construction time. Your contract is
untouched.

## Gotchas

1. **`verifyClient` runs in `ws`'s upgrade callback, before any
   framework middleware.** Don't try to read `request.user` from a
   Passport middleware — it isn't populated. Parse the token off the
   URL (or the upgrade `Authorization` header) yourself.
2. **`connectionKey` defaults to `undefined`.** That disables
   single-connection-per-user enforcement (and `closeUser()` lookups)
   for that connection. Return the user's stable id if you want "one
   session per user."
3. **Heartbeat namespace collision throws at construction.** If your
   router already has a top-level `__orpc_ws_lib__` key, rename it.
4. **Uploads default to off.** `getHttpHandler()` returns `null` unless
   you pass `uploads: { enabled: true, httpPath: "/upload" }`. The
   NestJS adapter reads this for Express route registration.

## See also

- Top-level [README](../../README.md)
- [`@repo/orpc-ws-server-nestjs`](../orpc-ws-server-nestjs) — NestJS adapter
- [`@repo/orpc-ws-client`](../orpc-ws-client) — paired client
- [Sequence diagrams](../../docs/diagrams/)
- [src/index.ts](./src/index.ts) — full export surface

[`ws`]: https://github.com/websockets/ws
[`@orpc/server`]: https://github.com/unnoq/orpc

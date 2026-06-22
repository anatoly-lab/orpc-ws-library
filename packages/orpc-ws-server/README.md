# `@orpc-ws/server`

Framework-free ORPC-over-WebSocket server core. Vanilla Node + [`ws`] +
[`@orpc/server`]. The composition root (`OrpcWsServer`) attaches to a
plain `http.Server`; no `@nestjs/*`, no `express`, no `fastify`. On
NestJS, use [`@orpc-ws/server-nestjs`](../orpc-ws-server-nestjs)
instead — it wraps this core in Nest's lifecycle.

## Install

```bash
npm install @orpc-ws/server
```

`ws` and `@orpc/server` are direct dependencies. You bring your own
`http.Server`.

## Quickstart

```ts
import { createServer } from "http";
import { createOrpcWsServer } from "@orpc-ws/server";
import type { VerifyClientContext } from "@orpc-ws/server";
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
const wsServer = createOrpcWsServer({
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

> **Construction API.** `createOrpcWsServer(...)` is the documented entry
> point for the authenticated server (and `createAuthlessOrpcWsServer(...)`
> for the [authless mode](#authless-mode) below). Both are thin factories
> over the underlying `OrpcWsServer` class, which is still exported as an
> advanced/internal entry — prefer the factories.

## `verifyClient`

```ts
type VerifyClientResult<TUser> =
  | { ok: true; user: TUser; connectionKey?: string; expiresAt?: number }
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

### Token lifetime on live connections

Auth runs **once**, pre-101. By default a connection authenticated with
a short-lived token stays open past the token's `exp` — the heartbeat
keeps it alive. Two opt-in levers close that gap:

1. **Time-based expiry** — return `expiresAt` (epoch **milliseconds**;
   JWT `exp` is seconds, so `exp * 1000`) from `verifyClient` and set
   `connection: { enforceTokenExpiry: true }`. The server closes the
   socket with `authFailedCloseCode` (default `4001`, `"Token expired"`)
   when the instant passes; the library client treats 4001 as
   refresh-and-reconnect, so a healthy session rolls over seamlessly.
   `@orpc-ws/oidc-verifier-jose` populates `expiresAt` automatically.
2. **External invalidation** (logout-everywhere, admin revocation) —
   subscribe to your own invalidation stream and call
   `server.closeUser(sub, 4001, "session invalidated")`. The library
   ships no built-in pub/sub for this; the transport is yours.

### Operational security

The paired client sends the WS token as a `?token=` query parameter on
the upgrade URL. The library itself never logs the token — but anything
in front of it might: reverse-proxy and load-balancer access logs, and
APM traces, capture full request URLs (JWT included) unless told not
to. If you terminate `/ws` behind nginx, an ALB, Cloudflare, etc.:

1. **Scrub or disable query-string logging** on the `/ws` path (e.g.
   drop the `token` parameter from the log format).
2. **Serve over `wss://`** — TLS already encrypts the URL on the wire;
   the exposure is logs, not transit.
3. If query-string tokens are unacceptable in your environment, omit
   `tokenProvider` on the client and use **cookie auth** instead — the
   browser attaches cookies to the upgrade request, and your
   `verifyClient` reads them off `ctx.req`.

## Authless mode

Not every service authenticates. For internal tools, public read-only
feeds, or a localhost demo, you want the WS transport (RPC +
AsyncIterable subscriptions + heartbeat) with **no auth at all**. That's
a first-class mode — not an "always-accept" `verifyClient`.

Pick the factory that matches:

| Factory | Auth | Use when |
|---|---|---|
| `createOrpcWsServer({ router, verifyClient, … })` | authenticated | you need a principal — the everyday path |
| `createAuthlessOrpcWsServer({ router, … })` | none | every upgrade accepted, no principal |

```ts
import { createServer } from "http";
import { createAuthlessOrpcWsServer } from "@orpc-ws/server";
import { os } from "@orpc/server";

const appRouter = {
  feed: { latest: os.handler(async () => readPublicFeed()) },
};

const httpServer = createServer();
const wsServer = createAuthlessOrpcWsServer({
  router: appRouter,
  // No verifyClient — every WS upgrade is accepted.
  // connection / heartbeat / hooks / logger / clock still apply.
});
wsServer.attach(httpServer);
httpServer.listen(3000);
```

What's different from the authenticated path:

- **Empty ORPC context.** Procedures run with `{}` — there is no `user`
  and no `token` on the context. (The option/return types make this a
  compile-time fact: an authless build never declares or sees a `TUser`.)
- **No single-session enforcement.** Each connection gets a unique
  internal registry key, so anonymous connections never kick each other
  — no `4005` session-replace. Many clients coexist freely.
- **No uploads, no token-expiry, no `closeUser`.** The HTTP upload
  transport authenticates with the same Bearer token the WS uses, which
  authless has none of; `enforceTokenExpiry` has no token to expire; and
  with no per-user identity there's nothing for `closeUser` to target —
  so the returned type omits it. (Authless having no uploads is
  deliberate; it can be added later without an API change.)
- **Smaller hooks.** `onConnected(ws)` / `onDisconnected(code, ws)` /
  `onZombieTerminated()` — none take a `user`, and there's no `onKicked`
  (nothing is ever kicked).

Heartbeat still runs (it's pre-auth liveness — see [Heartbeat](#heartbeat)).

> **Use the factory.** `createAuthlessOrpcWsServer` is the supported
> authless entry point. The bare `OrpcWsServer` class is the
> advanced/internal entry; authless consumers should not construct it
> directly.

On NestJS, the same mode is reached with
`OrpcWsModule.forRoot({ mode: "authless", router })` — see
[`@orpc-ws/server-nestjs`](../orpc-ws-server-nestjs/README.md#authless-mode).

## OIDC verifier

For OIDC against any spec-compliant IdP (Keycloak, Auth0, Okta,
Cognito, Google), drop in
[`@orpc-ws/oidc-verifier-jose`](../oidc-verifier-jose/README.md):

```ts
import { createOidcVerifyClient } from "@orpc-ws/oidc-verifier-jose";

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

## Uploads

Opt-in HTTP transport for file-bearing procedures (ORPC multipart over
HTTP). Off by default; `getHttpHandler()` returns `null` until you pass
`uploads`:

```ts
uploads: {
  enabled: true,
  httpPath: "/upload",       // default
  bodyLimitBytes: 50 * 1024 * 1024,  // override the 25 MB default cap
}
```

The HTTP route reuses the same `verifyClient` as the WS path (Bearer
header instead of URL token).

### `beforeUpload`

Optional pre-body-buffer gate, also on `uploads`. Runs **after**
`verifyClient` succeeds (so it gets the authenticated `user`) and
**before** the request body is read — so you can reject by
`content-type` / `content-length` without ever buffering the bytes,
and without overloading `verifyClient` (which is WS auth, runs pre-101,
and never learns it's gating an upload).

```ts
type BeforeUploadContext<TUser> = {
  headers: IncomingHttpHeaders;  // read content-type / content-length
  user: TUser;                   // the verified principal
  req: IncomingMessage;          // escape hatch
};

type BeforeUploadResult =
  | { ok: true }
  | { ok: false; code?: number; reason?: string };

type BeforeUploadHook<TUser> =
  (ctx: BeforeUploadContext<TUser>) => BeforeUploadResult | Promise<BeforeUploadResult>;
```

Mirrors the `verifyClient` accept/reject convention. The one
difference: `code`/`reason` are **optional** on reject — the default is
`415 Unsupported Media Type` (the common "wrong content-type" case
needs no boilerplate; supply `code: 413` yourself for size). Fails
closed: a throw or a non-conforming return becomes a `500` reject, and
the RPC handler is never invoked.

```ts
uploads: {
  enabled: true,
  beforeUpload: ({ headers }) => {
    const ct = headers["content-type"] ?? "";
    if (!ct.startsWith("image/")) {
      return { ok: false, reason: "Images only" };  // 415 by default
    }
    return { ok: true };
  },
}
```

Threads through the NestJS adapter unchanged — it's part of `uploads`.

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
   you pass `uploads: { enabled: true, httpPath: "/upload" }` (plus
   optional `bodyLimitBytes` and a `beforeUpload` gate — see
   [Uploads](#uploads)). The NestJS adapter reads this for Express route
   registration.

## See also

- Top-level [README](../../README.md)
- [`@orpc-ws/server-nestjs`](../orpc-ws-server-nestjs) — NestJS adapter
- [`@orpc-ws/client`](../orpc-ws-client) — paired client
- [Sequence diagrams](../../docs/diagrams/)
- [src/index.ts](./src/index.ts) — full export surface

[`ws`]: https://github.com/websockets/ws
[`@orpc/server`]: https://github.com/unnoq/orpc

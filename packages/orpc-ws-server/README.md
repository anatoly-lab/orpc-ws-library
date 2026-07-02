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
  // hooks:      { onConnected: (conn) => ..., onKicked: ... },
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
- **Single global connection (default).** All authless sockets share one
  internal registry key, so a new connection **kicks** the previous one —
  the prior socket is closed with `4005` (session-replaced) and the
  library client maps `4005` to the terminal `kicked` state (it does not
  reconnect). This models a single-GUI remote-control server where the
  newest tab takes over. To restore coexistence, set
  `allowConcurrentConnections: true` — each connection then gets a unique
  key, nothing is kicked, and any number of anonymous clients coexist
  freely.
- **No uploads, no token-expiry, no `closeUser`.** The HTTP upload
  transport authenticates with the same Bearer token the WS uses, which
  authless has none of; `enforceTokenExpiry` has no token to expire; and
  with no per-user identity there's nothing for `closeUser` to target —
  so the returned type omits it. (Authless having no uploads is
  deliberate; it can be added later without an API change.)
- **Smaller hooks — but `onKicked` is available.** `onConnected(conn)` /
  `onDisconnected(conn, code)` / `onZombieTerminated()` — the `conn`
  carries no `user` (it's `{ key, ws }`, plus `client` when bidi is on).
  Authless also has a user-less `onKicked?: (replacedBy: WebSocket) =>
  void`, which fires in the default single-connection mode when a new
  connection replaces the previous (it carries only the replacing socket,
  no `user`); it never fires under `allowConcurrentConnections: true`.

Heartbeat still runs (it's pre-auth liveness — see [Heartbeat](#heartbeat)).

> **Use the factory.** `createAuthlessOrpcWsServer` is the supported
> authless entry point. The bare `OrpcWsServer` class is the
> advanced/internal entry; authless consumers should not construct it
> directly.

### Out-of-band push (`SINGLE_AUTHLESS_KEY`)

In the default single-connection mode every authless socket shares one
registry key — exported as `SINGLE_AUTHLESS_KEY` (value `"authless"`). It
lets you reach the one live GUI from **outside** the connection lifecycle
and push to it via server→client RPC:

```ts
import { SINGLE_AUTHLESS_KEY } from "@orpc-ws/server";

// e.g. an MCP tool handler reacting to an external command:
server.getConnection(SINGLE_AUTHLESS_KEY)?.client.notify({ text: "hi" });
```

- **Bidi must be on** for `.client` to exist — pass a `clientContract`
  (see [Server→client RPC](#serverclient-rpc-bidirectional)); the push is a
  server→client call.
- **Prefer the in-lifecycle route when you can.** If the push originates
  *inside* the connection lifecycle, capture `conn` from `onConnected` and
  hold `conn.client` — that's cleaner and avoids the registry lookup.
  `SINGLE_AUTHLESS_KEY` is specifically for pushes triggered by something
  **external** to the connection (an MCP tool handler, a webhook, a timer).
- **Only meaningful in the default single-connection mode.** Under
  `allowConcurrentConnections: true` each connection has its own unique key,
  so there is no single shared key to look up.

NestJS consumers import `SINGLE_AUTHLESS_KEY` from
[`@orpc-ws/server-nestjs`](../orpc-ws-server-nestjs/README.md) (re-exported)
and push via the service's typed `getConnection` mirror:
`OrpcWsService.getConnection<TClientContract>(SINGLE_AUTHLESS_KEY)?.client.notify(…)`
— prefer this over `getServer().getConnection(…)`, whose `AnyOrpcWsServer`
return type erases the typed `.client`.

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

## Server→client RPC (bidirectional)

By default the WS is one-way at the RPC layer: the client calls procedures the
server hosts. **Opt in** to the reverse — the server calls procedures the
**client** hosts — over the *same* socket. It's additive: omit the
`clientContract` option and the server is byte-identical to a one-way server
(no multiplexer, no `conn.client`). Nothing is enabled by default.

### Connection handle (`conn`)

The lifecycle hooks and `getConnection` deal in a single `conn` object — not
positional `(user, ws)` args:

```ts
hooks: {
  onConnected(conn) {
    // conn: { key, user, ws }   (+ `client` when bidi is on, see below)
  },
  onDisconnected(conn, code) {
    // same conn, plus the WS close `code`
  },
}
```

(Authless drops `conn.user` — see [Authless mode](#authless-mode).)

### Enabling it

Pass a `clientContract` — the **client's** contract router, i.e. the procedures
the client will answer. Its presence flips bidi on and gives every connection a
typed `conn.client` caller:

```ts
import { createServer } from "http";
import { createOrpcWsServer } from "@orpc-ws/server";
import { oc } from "@orpc/contract";
import { os } from "@orpc/server";
import { z } from "zod";

// The CLIENT's contract — what the client agrees to answer. (The matching
// implementations are hosted on the client; see @orpc-ws/client.)
const clientContract = {
  showToast: oc.input(z.object({ message: z.string() })),
};

const appRouter = {
  ping: os.handler(async () => "pong"),
};

// No explicit generics — TUser, TContract AND TClientContract all infer from
// the options (verifyClient / router / clientContract). See the footgun below.
const wsServer = createOrpcWsServer({
  router: appRouter,
  verifyClient,
  clientContract,           // ← presence turns bidi on; drives `conn.client`'s type
  hooks: {
    onConnected(conn) {
      // conn.client is the typed server→client caller.
      void conn.client.showToast({ message: "Welcome!" });
    },
  },
});
wsServer.attach(createServer().listen(3000));
```

Call it from a hook (`onConnected(conn)`) or out-of-band by key:

```ts
await server.getConnection(userKey)?.client.showToast({ message: "Build done" });
```

`conn.client` is typed `ContractRouterClient<typeof clientContract>` and is
**absent from the type** when no `clientContract` was passed — a one-way server
can't accidentally reach for a caller that doesn't exist.

Authless bidi works the same way — `createAuthlessOrpcWsServer({ router,
clientContract, hooks })` — the `conn` simply carries no `user`.

> **Footgun — pass the VALUE, not just the generic.** The runtime bidi switch
> is `clientContract !== undefined`; `conn.client`'s *type* presence is driven
> by the third generic. The two are independent and TS can't bind them. Prefer
> letting the generic infer (write **no** explicit type arguments, as above).
> If you do write generics, never specify the third one without also passing the
> `clientContract` value — `createOrpcWsServer<U, R, SomeContract>({ router,
> verifyClient })` compiles, types `conn.client` as present, yet it is
> `undefined` at runtime. Passing the value keeps type and runtime in lockstep.

> **Don't call `conn.client` from `onDisconnected`.** By the time that hook
> fires the connection is already torn down: `conn.client` is still a live
> reference, but any call on it **rejects** (the s2c peer is closed). Observe
> its presence there if you must; never invoke it.

### Security: trust inversion ⚠️

Hosting a client router means the **browser now executes procedures the server
invokes** — the trust arrow flips. This is a real attack surface; the guidance
lives where you write those handlers, in
[`@orpc-ws/client` → Server→client RPC](../orpc-ws-client/README.md#serverclient-rpc-bidirectional).
In short: expose only procedures that are safe to be server-driven (UI notify,
cache-invalidate), validate every input, and never expose ambient-authority or
exfiltration-style operations.

### Lost-ack / idempotency

There is **no library-imposed timeout** on a server→client call in v1. The
outcomes of `await conn.client.x(...)`:

- **resolves** → the client invoked *and* completed it;
- **rejects with an ORPC error** → it was invoked and the handler threw;
- **rejects from a transport/close error** → **ambiguous** — the call may or
  may not have executed (classic lost-ack). In-flight calls reject (they don't
  hang) when the connection closes.

For exactly-once semantics, add app-level idempotency (e.g. a client-side
dedupe key) — the library does not retry s2c calls for you.

### Error sink

Inbound bidi dispatch errors (a malformed frame, a throwing listener) are
routed to the injected `logger`. Keep that sink **total** — a `logger` that
itself throws is not isolated from the dispatch loop.

> **Streams are deferred.** v1 is request/response only. Server→client
> *AsyncIterable* streams are not supported yet; adding them later is additive.

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

> **Enabling uploads makes the whole router HTTP-reachable.** The HTTP
> handler is a second `RPCHandler` over the *same composed router* as the
> WS handler — "one router, two transports" is the pinned design. So with
> `uploads` on, **every** procedure (not just the file-bearing ones)
> becomes callable via `POST <httpPath>/<procedure-path>` with a valid
> Bearer token — including the library's stealth heartbeat:
> `POST <httpPath>/__orpc_ws_lib__/heartbeat` opens a per-request event
> stream. If a procedure must stay WS-only, enforce that inside the
> procedure or its middleware; the transport does not partition the
> router.

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

## Interceptors / error logging

Two optional passthrough options forward ORPC
[handler interceptors](https://github.com/unnoq/orpc) to the
library's internally-built `RPCHandler`(s) — the WS handler always, and
the HTTP upload handler too when `uploads` is configured. Both are
accepted on `createOrpcWsServer` **and** `createAuthlessOrpcWsServer`
(authless has no upload transport, so they wrap only its WS handler).

The headline use is a **single central error logger** that covers every
procedure regardless of how you composed your router — including
sub-routers spread in unwrapped (that's the whole point):

```ts
import { onError } from "@orpc/server";

createOrpcWsServer({
  router,
  verifyClient,
  interceptors: [
    onError((e) => logger.error({ err: e }, "orpc procedure error")),
  ],
});
```

### `interceptors` vs `rootInterceptors`

The footgun is wiring your error logger to the wrong layer:

- **`interceptors`** wrap the **procedure execution** and see the
  **thrown error**. Use them for error logging.
- **`rootInterceptors`** are the **outer** layer — they wrap the whole
  handle **including** ORPC's error→response mapping. By the time a
  `rootInterceptor` runs, a thrown procedure error has already been
  caught and encoded into a response, so a `rootInterceptors` `onError`
  **will NOT fire on a procedure throw**. Use `rootInterceptors` for
  whole-response shaping, top-level tracing spans, or short-circuiting —
  **not** for logging thrown errors.

### Coverage caveats

`interceptors` are not a catch-all. Three honest gaps:

1. **Mid-stream AsyncIterable errors are invisible.** They fire for
   unary procedure failures and subscription **setup** failures, but
   NOT for errors thrown mid-stream from an AsyncIterable — ORPC's
   `handle()` has already resolved by then. A subscription that yields
   fine and then throws minutes later never reaches the interceptor.
2. **HTTP upload pre-ORPC rejects are invisible.** On the upload
   transport, `verifyClient` / `beforeUpload` reject **before** the
   `RPCHandler` runs, so those failures don't reach the interceptor.
   (The WS transport is the clean case — no pre-handler gate.)
3. **Heartbeat runs with empty context.** Interceptors also wrap the
   library's internal heartbeat procedure, which runs with an empty
   `{}` context — an interceptor reading `context.user` gets
   `undefined` there.

Both options are accepted on the NestJS adapter too — see
[`@orpc-ws/server-nestjs`](../orpc-ws-server-nestjs/README.md#interceptors--error-logging).

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

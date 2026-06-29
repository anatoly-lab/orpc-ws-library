# `@orpc-ws/client`

Framework-free ORPC-over-WebSocket client core. Plain TypeScript — no
React, no Vue, no framework runtime. UI adapters live in sibling packages
(React: [`@orpc-ws/react`](../orpc-ws-react)) or as thin consumer-side
wrappers around a generic state contract.

## Install

```bash
npm install @orpc-ws/client
```

This core has no framework dependency. For React bindings, install the
sibling [`@orpc-ws/react`](../orpc-ws-react) adapter.

## Quickstart

```ts
import { createOrpcWsClient } from "@orpc-ws/client";
import type { contract } from "./contract.js";

const client = createOrpcWsClient<typeof contract>({
  url: "wss://api.example.com/ws",
  tokenProvider: {
    getToken: () => localStorage.getItem("token"),
    refresh: async () => {
      const r = await fetch("/auth/refresh", { method: "POST" });
      return r.ok ? (await r.json()).token : null;
    },
  },
  onTerminalAuthFailure: () => { location.href = "/login"; },
  onEvent: (e) => {
    if (e.type === "heartbeat_timeout") toast("Reconnecting...");
  },
});

client.connect();
const result = await client.rpc.todos.list({ limit: 10 });
```

## What the library handles for you

Reconnect (close-code analysis, exponential backoff, jitter, mutex,
debounce), heartbeat (dual-mechanism: ORPC stealth subscription + WS
ping/pong watchdog), sleep detection (Web Worker watches for clock
jumps, triggers reconnect on wake), and a 30 s storm guard that
de-duplicates all auth-failure triggers into a single window.

## Reconnect configuration

Pass a partial `reconnect` override to tune the reconnect path; every
field of `ReconnectConfig` (backoff delays, grow factor, connection
timeout, jitter, debounce, storm-guard window) is freely overridable —
**except one.**

> **`maxRetries` is fixed at `Infinity`; a finite value is unsupported.**
> If you pass a finite `reconnect.maxRetries`, the library logs a warning
> via the injected `logger` and ignores it, resetting it to `Infinity`.
> The library owns "give up" itself — at the right layer (the 30 s storm
> guard trips to terminal-auth, a `4005` close kicks the session,
> `dispose()` tears everything down), not via a retry cap. partysocket
> emits no event when its internal retry loop exhausts, so a finite cap
> would silently wedge `connect()` over a dead connection with no signal,
> and the library can't detect that without reading partysocket
> internals (a coupling we refuse). Leave `maxRetries` at its default.

## Lifecycle

```ts
client.connect();   // idempotent; library owns all reconnect logic
client.dispose();   // terminal teardown; create a new client to reconnect
```

That's the whole lifecycle — no `disconnect()`/`reconnect()` triplet.
Session-replaced-from-another-tab (close `4005`) moves the client to a
terminal `kicked` state; you don't call anything, the state simply
transitions. After `dispose()`, the client object is dead — create a
new one to reconnect post-logout.

## State and events

Two distinct observation channels — no overlap.

`client.state` — **what's true now.** Drives reactive UI.

```ts
type ConnectionState =
  | { status: "connecting" }
  | { status: "connected" }
  | { status: "disconnected"; code?: number; willRetry: boolean }
  | { status: "kicked"; reason: "session_replaced" };   // terminal

client.state.getState(): ConnectionState;
client.state.subscribe(cb: () => void): () => void;
```

`onEvent(evt)` — **things that happened.** Imperative notifications.

```ts
type ClientEvent =
  | { type: "auth_failure"; refreshable: boolean }
  | { type: "heartbeat_timeout" }
  | { type: "woke_from_sleep"; sleepDurationMs: number };
```

`refreshable: true` means a refresh attempt is coming (brief
"reconnecting" UX). `refreshable: false` pairs with
`onTerminalAuthFailure` — the library has given up.

## Server→client RPC (bidirectional)

Normally the client calls procedures the server hosts. **Opt in** to the
reverse — the server calls procedures **this client** hosts — over the *same*
socket (alongside your normal RPC and the heartbeat). It's additive: omit
`clientRouter` and the client is byte-identical to a one-way client (no
multiplexer, heartbeat untouched). Not enabled by default.

You provide a `clientRouter` — your own ORPC router, built off a bare `os` —
whose procedures **execute in the browser** when the server invokes them:

```ts
import { createOrpcWsClient } from "@orpc-ws/client";
import { os } from "@orpc/server";
import { z } from "zod";
import type { AppContract } from "./contract.js";

// The procedures this client answers. Built off a bare `os`, NOT your
// server contract. VALIDATE inputs — see the trust note below.
const clientRouter = {
  showToast: os
    .input(z.object({ message: z.string() }))
    .handler(({ input }) => {
      toast(input.message); // runs HERE, in the browser
    }),
};

// BOTH generics are MANDATORY and must be written explicitly.
const client = createOrpcWsClient<AppContract, typeof clientRouter>({
  url: "wss://api.example.com/ws",
  clientRouter,
});
client.connect();
```

> **Both type arguments are required — TS cannot infer the second.** `TContract`
> appears only in the *return* type, so it must always be given explicitly; and
> TypeScript does not do partial type-argument inference, so once you supply the
> first, an omitted `TClientRouter` falls to its default (`never` = bidi off)
> rather than being inferred from `clientRouter`. Always write
> `createOrpcWsClient<MyContract, typeof clientRouter>({ ... })`. (To enforce
> this, `clientRouter` is a *required* option on the bidi-on path — passing the
> generic but omitting the value is a compile error.)

If your `clientRouter` declares an initial ORPC context, pass `clientContext` —
it's typed against the router and becomes **required** exactly when the router
requires one (a context-free router built off a bare `os` needs none):

```ts
// A router that declares an initial context:
const base = os.$context<{ store: CacheStore }>();
const ctxRouter = {
  invalidate: base.handler(({ context }) => context.store.clear()),
};

createOrpcWsClient<AppContract, typeof ctxRouter>({
  url,
  clientRouter: ctxRouter,
  clientContext: { store },   // REQUIRED here — typed as { store: CacheStore }
});
```

The server side (enabling `clientContract`, calling `conn.client.<proc>()`) is
documented in
[`@orpc-ws/server` → Server→client RPC](../orpc-ws-server/README.md#serverclient-rpc-bidirectional).

### Trust inversion — your responsibility ⚠️

Hosting a `clientRouter` flips the trust arrow: the browser now runs procedures
the **server** invokes. Treat the hosted router as a **server-driven attack
surface**, not as trusted local code:

- **Expose only what's safe to be server-driven** — UI notifications, cache
  invalidation, re-fetch triggers. Never expose ambient-authority or
  exfiltration-style operations (e.g. "read a token from storage and return it",
  "run arbitrary fetch", "touch the filesystem").
- **Validate every input** (the `.input(z.object(...))` above) — the caller is
  remote.
- **Derive any authority from this client's own `clientContext`**, never from
  server-supplied request data.

### Caveats

- **Lost-ack:** v1 imposes no s2c-call timeout. A server→client call that
  rejects from a transport/close error is *ambiguous* — it may have executed.
  In-flight hosted executions abort (they don't hang) when the connection
  closes. See the server README for the full table.
- **Streams deferred:** request/response only in v1 — no server→client
  AsyncIterable streams yet (additive later).
- **Error sink:** an inbound dispatch error (bad frame / throwing handler) is
  routed to the injected `logger` and must not crash the page; keep that sink
  total.

### Late-binding the router — `createDelegatingClientRouter`

`clientRouter` is captured **once** at `createOrpcWsClient` construction:
rebuilding it rebuilds the client (a reconnect). That's fine for a static
router, but a framework adapter wants handlers that close over live
component/render state — fresh function identities every render — *without*
re-creating the client. `createDelegatingClientRouter` is the bridge:

```ts
import { createDelegatingClientRouter, createOrpcWsClient } from "@orpc-ws/client";

// Stable shape from a fixed key set; leaves delegate, per call, to whatever
// `getHandlers()` currently returns.
const router = createDelegatingClientRouter(
  ["showToast"],
  () => currentHandlers,   // read fresh on every server→client call
);

createOrpcWsClient<AppContract, typeof router>({ url, clientRouter: router });
```

The router's **identity never changes** (its structure is fixed by the `names`
array, so it can be hosted for the life of the client), while each invocation
reads the live handler map and dispatches to the current handler. A call for a
name absent from the current map throws an `ORPCError("NOT_FOUND")` **at call
time** (not construction) — a server invoking an unregistered procedure fails
loudly rather than resolving `undefined`. Handler in/out is `unknown` here: this
is framework-free structural glue; the typed surface is layered on by an adapter.

> **Most React consumers never call this directly** — the
> [`@orpc-ws/react`](../orpc-ws-react) `<OrpcWs>` component uses it internally to
> host a flat, render-updated handler map. It's public so framework adapters
> (and advanced consumers) can reuse the same late-binding bridge.

## Uploads — opt-in HTTP transport

```ts
const client = createOrpcWsClient<typeof contract>({
  url: "wss://api.example.com/ws",
  tokenProvider,
  uploads: {
    strategy: "orpc-http",
    httpUrl: "https://api.example.com/upload",
  },
});

await client.upload(file, {
  procedure: ["files", "upload"],    // typed against TContract
  onProgress: (p) => console.log(p.loaded / p.total),
  signal: abortController.signal,
});
```

When `uploads` is omitted, `client.upload` is not present on the object.
Same `tokenProvider` produces a `Bearer` header for the HTTP side. Only
v1 strategy is `"orpc-http"`; `"presigned-url"` is reserved in the type
union and throws at runtime.

## React adapter

The React bindings live in the sibling
[`@orpc-ws/react`](../orpc-ws-react) package (there is no
`@orpc-ws/client/react` sub-path — the core stays framework-free).

```tsx
import { useConnectionState } from "@orpc-ws/react";

function ConnectionBadge({ client }) {
  const conn = useConnectionState(client);
  if (conn.status === "connecting") return <span>connecting...</span>;
  if (conn.status === "disconnected" && conn.willRetry) {
    return <span>reconnecting...</span>;
  }
  return null;
}
```

`@orpc-ws/react` also exports `useWsSubscription`, an optional
`OrpcWsProvider`, a `useOrpcWs<TContract>()` hook, and `<OrpcWs>` — a
construct-and-own provider that builds the client (and hosts a React-aware
server→client `clientRouter`) for you — see its
[README](../orpc-ws-react/README.md).

## Other frameworks

The same `{ getState, subscribe }` state contract plugs into
`useSyncExternalStore` (React, already built-in), Svelte stores (with a
one-line bridge — `subscribe` doesn't fire immediately), Vue
`customRef`, and Solid `from()`.

## Auth

Auth is the consumer's choice; the core only needs an optional
`TokenProvider`. Two shapes are common:

- **Backend-token / native path** — your server (or IdP) mints a short-lived
  access token the client pulls and refreshes; you supply a `TokenProvider`
  whose `getToken`/`refresh` read it (see the Quickstart above). The token
  rides the WS handshake as `?token=`, verified server-side by
  [`@orpc-ws/oidc-verifier-jose`](../oidc-verifier-jose/README.md).
- **Cookie-BFF / authless** — omit `tokenProvider` entirely. With cookie-BFF,
  an httpOnly `sid` session cookie authenticates the handshake automatically
  (the browser never sees a token); see
  [`@orpc-ws/cookie-bff-client`](../orpc-ws-cookie-bff-client/README.md).

## Gotchas

1. **`connect()` is idempotent, but `dispose()` is one-way.** For
   "log out then log in," create a fresh `OrpcWsClient` after re-auth.
2. **`subscribe()` does NOT fire the callback immediately.** Read the
   initial value with `getState()`. Svelte stores need a one-line
   bridge for this.

## See also

- Top-level [README](../../README.md)
- [`@orpc-ws/server`](../orpc-ws-server) / [`@orpc-ws/server-nestjs`](../orpc-ws-server-nestjs) — paired servers
- [Sequence diagrams](../../docs/diagrams/)
- [src/index.ts](./src/index.ts) — full export surface

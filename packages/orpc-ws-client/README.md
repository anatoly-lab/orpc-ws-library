# `@orpc-ws/client`

Framework-free ORPC-over-WebSocket client core. Plain TypeScript — no
React, no Vue, no framework runtime. UI adapters live behind sub-path
entries (built-in `./react`) or as thin consumer-side wrappers around a
generic state contract.

## Install

```bash
npm install @orpc-ws/client
```

`react` is an optional peer — only required for the `./react` sub-path.

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

```tsx
import { useConnectionState } from "@orpc-ws/client/react";

function ConnectionBadge({ client }) {
  const conn = useConnectionState(client);
  if (conn.status === "connecting") return <span>connecting...</span>;
  if (conn.status === "disconnected" && conn.willRetry) {
    return <span>reconnecting...</span>;
  }
  return null;
}
```

Optional provider + `useOrpcWs<TContract>()` hook also exported — see
[`src/index.ts`](./src/index.ts).

## Other frameworks

The same `{ getState, subscribe }` state contract plugs into
`useSyncExternalStore` (React, already built-in), Svelte stores (with a
one-line bridge — `subscribe` doesn't fire immediately), Vue
`customRef`, and Solid `from()`.

## Auth helper

For OIDC + PKCE against any spec-compliant IdP (Keycloak, Auth0, Okta,
Cognito, Google), use [`@orpc-ws/oidc-pkce`](../oidc-pkce/README.md) — its
`createOidcAuth().tokenProvider` is structurally compatible with the
`TokenProvider` interface and handles PKCE crypto, token storage,
refresh purity, OIDC discovery, and the callback dance.

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

# `@orpc-ws/react`

The **WS-transport React bindings** — hooks and a provider that adapt the
framework-free `@orpc-ws/client` core to React. This is the **sole React
adapter** for this library: it binds the WebSocket transport client core
only. It does **not** re-export the core; the client factory (and its types)
come straight from `@orpc-ws/client`.

Auth is the consumer's concern, decoupled from this adapter. Whether you
authenticate with a custom `TokenProvider` (backend-token / native path) or
a cookie/BFF session, you construct your `@orpc-ws/client` accordingly and
pass it to these hooks — this package imports nothing auth-related.

## Install

```bash
npm install @orpc-ws/react @orpc-ws/client
```

`react` (>=18) is a peer dependency.

```ts
import { createOrpcWsClient, consoleLogger } from "@orpc-ws/client";
import { useConnectionState, OrpcWsProvider, useOrpcWs } from "@orpc-ws/react";

// Construct the framework-free client from the core:
const client = createOrpcWsClient<MyContract>({
  url: "wss://…",
  logger: consoleLogger,
});

// Use the React bindings from this package:
function App() {
  return (
    <OrpcWsProvider client={client}>
      <Status />
    </OrpcWsProvider>
  );
}

function Status() {
  const state = useConnectionState(useOrpcWs<MyContract>());
  return <span>{state.status}</span>;
}
```

## What's here

This package exports the WS-transport React bindings only:

- **`useConnectionState(client)`** — `useSyncExternalStore` binding to the
  client's reactive connection state.
- **`useWsSubscription(client, subscribe, options?)`** — subscribes a
  component to a server-pushed ORPC AsyncIterable stream and owns the whole
  lifecycle (connected-gating, abort teardown, re-subscribe on reconnect,
  error surfacing). See below.
- **`OrpcWsProvider` / `useOrpcWs()`** — optional context helper for sharing
  one client across the tree. `OrpcWsProviderProps` types the provider.

Types are exported alongside the hooks: `OrpcWsProviderProps`,
`UseWsSubscriptionOptions`, `UseWsSubscriptionResult`.

## Connection state — `useConnectionState`

`useConnectionState` binds the client's `{ getState, subscribe }` state
contract to React via `useSyncExternalStore`, so a component re-renders on
every connection-state transition.

```tsx
import { useConnectionState } from "@orpc-ws/react";

function ConnectionBadge({ client }) {
  const conn = useConnectionState(client);
  if (conn.status === "connecting") return <span>connecting…</span>;
  if (conn.status === "disconnected" && conn.willRetry) {
    return <span>reconnecting…</span>;
  }
  return null;
}
```

The returned `ConnectionState` is the same tagged record the core exposes
(`connecting` / `connected` / `disconnected` / `kicked`) — see
[`@orpc-ws/client`](../orpc-ws-client/README.md).

## Subscribing to a server stream — `useWsSubscription`

ORPC procedures can return an `AsyncIterable` — a server-pushed stream (a
live tick, presence updates, a job's progress). Consuming one in React is
fiddly: gate on the WS being connected, open an `AbortController`, pump the
iterator, suppress the abort-as-throw on teardown, re-subscribe when the
socket reconnects, and surface real errors. `useWsSubscription` owns all of
that so a page never repeats it. Under the hood it wraps ORPC's first-class
`consumeEventIterator` helper.

```tsx
import { useWsSubscription } from "@orpc-ws/react";

function LiveTick() {
  const { data: lastTick } = useWsSubscription(
    wsClient,
    (rpc, signal) => rpc.tick(undefined, { signal }),
  );
  return <p>{lastTick ? `tick #${lastTick.tick}` : "waiting…"}</p>;
}
```

**Signature.** `useWsSubscription(client, subscribe, options?)`:

- `client` — the `OrpcWsClient` from `createOrpcWsClient` (same instance
  across renders).
- `subscribe` — a selector `(rpc, signal) => Promise<AsyncIterable<TEvent>>`.
  You get the typed `rpc` proxy and an `AbortSignal` to thread into the
  call's options. The selector may be a fresh inline closure every render —
  it's read through a ref, so a new identity does not re-subscribe.
- `options` — optional `{ onEvent?, onError?, enabled? }`.

**Returns** `{ data, error, status }`: `data` is the **latest** event (or
`null` before the first; it persists across reconnects), `error` is the last
non-abort error, and `status` is `"idle"` (not subscribed — disconnected or
disabled), `"active"`, or `"error"`.

**The "both" shape.** The hook tracks the latest event in `data` **and**
forwards every event to your `onEvent` callback. Use `data` for reactive
render; use `onEvent` for imperative reactions (append to a log, fire a
toast). They're not either/or.

**`enabled`.** Pass `enabled: false` to suspend the subscription while the
component stays mounted (a paused view, a feature flag) without subscribing
even when the WS is connected; flip it back to `true` to resume.

**Connected-gating + re-subscribe.** The hook subscribes only while the WS
is `connected` and `enabled !== false`. When the socket drops it tears down
(abort + `consumeEventIterator`'s own cancel) and goes `idle`; when it
reconnects it re-subscribes automatically. Aborts from teardown are
suppressed — they never reach `error` or `onError`.

## Where the rest lives

The framework-free APIs are imported **directly from the core** — this
package does not wrap or re-export them:

- **`@orpc-ws/client`** — the WS client core: `createOrpcWsClient`,
  `consoleLogger`, `ConnectionState`, `OrpcWsClient`, config, logger
  bridges, …

Keeping this package React-only keeps the layering honest: the core stays
the single source of its own public surface, and future framework adapters
(`-svelte`, `-vue`, `-solid`) follow the same rule — framework bindings
only, no core re-exports.

## See also

- Top-level [README](../../README.md)
- [`@orpc-ws/client`](../orpc-ws-client) — the WS core this adapter binds

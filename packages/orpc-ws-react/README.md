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
- **`<OrpcWs>`** — the higher-level **construct-and-own** provider: builds the
  client from props, owns its connect/dispose lifecycle, and renders
  `OrpcWsProvider` underneath. See below.

Types are exported alongside the hooks: `OrpcWsProviderProps`,
`UseWsSubscriptionOptions`, `UseWsSubscriptionResult`, `OrpcWsProps`,
`ClientRouterHandlers`.

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

## Construct-and-own provider — `<OrpcWs>`

`OrpcWsProvider` takes a **pre-built** client — you call `createOrpcWsClient`
yourself, own its lifecycle (`connect`/`dispose`), and pass the instance down.
`<OrpcWs>` is the higher-level complement: it **constructs** the client from
props, owns connect-on-mount / dispose-on-unmount (StrictMode-safe), and
renders `OrpcWsProvider` *underneath* — so `useOrpcWs`, `useConnectionState`,
and `useWsSubscription` work unchanged below it. It's composition, not a
replacement.

```tsx
import { useState } from "react";
import { OrpcWs } from "@orpc-ws/react";
import type { MyClientContract } from "./contract.js";

function App() {
  const [toasts, setToasts] = useState<string[]>([]);

  return (
    <OrpcWs<MyClientContract>
      url="wss://api.example.com/ws"
      fallback={<Spinner />}
      // Flat server→client handler map. `showToast` is defined in render, so
      // it closes over `setToasts` — a SERVER push mutates live React state.
      clientRouter={{
        showToast: ({ text }) => {
          setToasts((current) => [...current, text]);
          return { shown: true };       // typed against MyClientContract
        },
      }}
    >
      <Home />
    </OrpcWs>
  );
}
```

**Construction options are initial-only.** `<OrpcWs>` accepts every
`createOrpcWsClient` option (`url`, `tokenProvider`, `onEvent`, `reconnect`,
`logger`, `uploads`, …) and reads them **once**, at construction — changing
them across renders has no effect (build a new tree to change them). The bidi
`clientRouter` / `clientContext` are the exception: `<OrpcWs>` owns them and
supplies the core a stable delegating router + empty context itself.

**The React-aware `clientRouter`.** Where the core's `clientRouter` is a full
ORPC router fixed at construction (see
[`@orpc-ws/client` → Server→client RPC](../orpc-ws-client/README.md#serverclient-rpc-bidirectional)),
`<OrpcWs>`'s `clientRouter` prop is a **flat handler map** —
`{ proc: (input) => output | Promise<output> }`. Handlers are defined in
render, so they can close over hooks and component state (the `setToasts`
above); `<OrpcWs>` reads them through a render-updated ref and hands the core
one identity-stable delegating router, so a fresh handler closure each render
does **not** rebuild the client (no reconnect storm). That's the whole value
proposition: a server→client call mutates the *current* render's UI without
re-creating the connection.

> The set of procedure **keys** is fixed at the first render (the router shape
> is identity-stable). Adding keys to `clientRouter` on a later render has no
> effect. FLAT for v1 — no nested namespaces.

**Single generic — type the handler map.** `<OrpcWs>` takes exactly one type
parameter, `TClientContract` (the server→client contract). Write it explicitly
to type the `clientRouter` map:

```tsx
<OrpcWs<MyClientContract> clientRouter={{ showToast }}>…</OrpcWs>
```

Omitting the generic falls to the default `never` — the **bidi-off** case:
drop the `clientRouter` prop and `<OrpcWs>` is a plain one-way construct-and-own
provider. (The component is generic *only* over `TClientContract`; your
client→server contract is asserted at the read site via `useOrpcWs<MyContract>()`,
not as a generic here.)

**`fallback`.** Rendered until the WS reaches `connected`; the children mount
only once connected. Omit `fallback` to always render `children` (even
pre-connect) — the connection state is still observable below via
`useConnectionState`.

**When to use which.** Reach for `<OrpcWs>` for the common case — let it build
and own the client. Keep `OrpcWsProvider` as the low-level escape hatch when
*you* must build and own the client (a module-level singleton, a custom
lifecycle, sharing one client across multiple trees).

The server side — enabling `clientContract`, calling `conn.client.<proc>()` —
is documented in
[`@orpc-ws/server` → Server→client RPC](../orpc-ws-server/README.md#serverclient-rpc-bidirectional).
The same **trust-inversion** caveats apply: a hosted handler runs procedures
the *server* invokes, so validate inputs and expose only what's safe to be
server-driven.

### API

- **`<OrpcWs<TClientContract> {...props}>`** — `props` is `OrpcWsProps`.
- **`OrpcWsProps<TClientContract>`** — every `createOrpcWsClient` construction
  option **minus** `clientRouter` / `clientContext`, plus: `clientRouter?`
  (the flat handler map, optional — omit for bidi-off), `fallback?: ReactNode`,
  and `children: ReactNode`.
- **`ClientRouterHandlers<TClientContract>`** — the type of the `clientRouter`
  prop: `{ [K in proc]: (input) => output | Promise<output> }`, with input /
  output derived from the contract via ORPC's `InferContractRouterInputs` /
  `InferContractRouterOutputs`. Defaults to `never` (bidi off).

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

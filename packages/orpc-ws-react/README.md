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
  `OrpcWsProvider` underneath. Pass `clientContract` to turn on server→client
  (bidi) calls. See below.
- **`createServerHandlerHook<TClientContract>()`** — a hook factory for the
  bidi path: bind your server→client contract once, get back a typed
  `useServerHandler` hook that registers a handler implementation from any
  component *below* `<OrpcWs>`. See below.

Types are exported alongside the hooks: `OrpcWsProviderProps`,
`UseWsSubscriptionOptions`, `UseWsSubscriptionResult`, `OrpcWsProps`.

The server→client (bidi) surface adds one value export,
`createServerHandlerHook` (a hook factory — see below).

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
disabled), `"active"`, `"error"`, or `"completed"` (the stream finished —
the server iterator returned `done`). Completion does **not** re-subscribe:
a finished stream stays `completed` (with `data` keeping the last event)
until the next disconnect→reconnect cycle or an `enabled` toggle re-runs
the subscription.

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
suppressed — they never reach `error` or `onError` — and so is the
abort-shaped rejection a connection drop itself produces on the in-flight
stream: a mid-stream reconnect blip cycles `active → idle → active` without
flashing `status: "error"` or firing `onError`. The same goes for a drop
landing in the window between the connected render and the subscribe effect:
the client core rejects that race with its typed `LinkNotReadyError`
(exported from `@orpc-ws/client`), which the hook also suppresses as
transient — no `error` flash, no `onError`; it self-heals silently on the
next reconnect (`active → idle → active`).

## Construct-and-own provider — `<OrpcWs>`

`OrpcWsProvider` takes a **pre-built** client — you call `createOrpcWsClient`
yourself, own its lifecycle (`connect`/`dispose`), and pass the instance down.
`<OrpcWs>` is the higher-level complement: it **constructs** the client from
props, owns connect-on-mount / dispose-on-unmount (StrictMode-safe), and
renders `OrpcWsProvider` *underneath* — so `useOrpcWs`, `useConnectionState`,
and `useWsSubscription` work unchanged below it. It's composition, not a
replacement.

```tsx
import { OrpcWs } from "@orpc-ws/react";
import { clientContract } from "./contract.js"; // oc.router({ showToast, … })

function App() {
  return (
    // `clientContract` turns bidi ON and infers TClientContract — no explicit
    // generic. Handler IMPLEMENTATIONS live in a child (see <ServerToasts>),
    // because they register through context the provider supplies.
    <OrpcWs url="wss://api.example.com/ws" fallback={<Spinner />} clientContract={clientContract}>
      <ServerToasts />
      <Home />
    </OrpcWs>
  );
}
```

Bind the contract once — typically in a tiny module — to get a typed
`useServerHandler` hook:

```ts
// lib/ws.ts
import { createServerHandlerHook } from "@orpc-ws/react";
import type { ClientContract } from "./contract.js";

export const useServerHandler = createServerHandlerHook<ClientContract>();
```

Then register the implementation from a component rendered **below**
`<OrpcWs>`. Because the handler is defined in render, it closes over hooks and
component state — a SERVER push mutates live React state:

```tsx
// ServerToasts.tsx — a CHILD of <OrpcWs>
import { useState } from "react";
import { useServerHandler } from "./lib/ws.js";

function ServerToasts() {
  const [toasts, setToasts] = useState<string[]>([]);

  // `name` is constrained to the contract's procedure keys; input/output are
  // pinned per procedure. The handler returns the procedure's output.
  useServerHandler("showToast", ({ text }) => {
    setToasts((current) => [...current, text]);
    return { shown: true };
  });

  return <ToastStack toasts={toasts} />;
}
```

**Construction options are initial-only.** `<OrpcWs>` accepts every
`createOrpcWsClient` option (`url`, `tokenProvider`, `onEvent`, `reconnect`,
`logger`, `uploads`, …) and reads them **once**, at construction — changing
them across renders has no effect (build a new tree to change them). The bidi
`clientContract` is the exception in *role*, not in timing: it too is read at
construction, and `<OrpcWs>` owns the core's `clientRouter` / `clientContext`
internally — supplying a stable delegating router + empty context itself.

**`clientContract` turns bidi on, and infers the type.** Pass the
server→client contract router **value** (e.g.
`clientContract = oc.router({ showToast })`) as the `clientContract` prop. Bidi
is ON iff that prop is present, and `TClientContract` is **inferred** from the
value — so there is **no** explicit generic on `<OrpcWs>`: write
`<OrpcWs clientContract={clientContract}>`, not `<OrpcWs<MyClientContract> …>`.
Drop the prop and `<OrpcWs>` is a plain one-way construct-and-own provider.
(Your client→server contract is asserted at the read site via
`useOrpcWs<MyContract>()`, not as a generic here.)

**Handlers register from below, through a hook — not a prop.** The handler
**implementations** are not passed to `<OrpcWs>`. Instead a child component
calls the typed hook from `createServerHandlerHook<TClientContract>()`:
`useServerHandler("showToast", ({ text }) => { … return { shown: true }; })`.
The hook must run *below* `<OrpcWs>` because it reads a registration context
the provider supplies — hence the `<ServerToasts>` child idiom above: put the
handler and the state it closes over into a small descendant component. The
hook reads the handler through a render-updated ref / a live registry, so a
fresh handler closure each render does **not** rebuild the client (no reconnect
storm). That's the whole value proposition: a server→client call mutates the
*current* render's UI without re-creating the connection.

> The hosted router's procedure **name set** is frozen at `<OrpcWs>`
> construction from the `clientContract` keys — children register
> implementations afterward, but the router shape can't grow after connect. The
> `clientContract` must be **flat** (v1): a nested sub-router throws a clear
> error at construction, naming the offending key.
> Duplicate registration for the same name is **last-registration-wins** and
> warns through the client's configured `logger` (not `console`); disposing an
> old registration deletes by identity, so it can't clobber a newer one.
> Calling a contract-declared procedure with **no** mounted handler throws
> `ORPCError("NOT_FOUND")` (the core delegating router's existing behavior),
> and a `useServerHandler` used with **no** `clientContract` on the ancestor
> `<OrpcWs>` throws a clear error.

**`fallback`.** Rendered until the WS reaches `connected` for the **first**
time; the children mount only once connected. The gate then **latches**: on a
later disconnect (a heartbeat blip, a reconnect cycle) the children **stay
mounted** and the fallback does **not** re-engage — re-mounting the subtree on
every blip would lose component state, unregister every `useServerHandler`,
and reset subscriptions. Observe reconnect blips below via
`useConnectionState` instead. Omit `fallback` to always render `children`
(even pre-connect).

### Registration timing — when a handler is ready

`useServerHandler` registers when its component **mounts**, not when `<OrpcWs>`
is constructed. That is a real, observable property — plan for it:

- **A registrant mounted in the SAME commit as `<OrpcWs>` (ungated) is ready
  before the socket opens.** React runs effects bottom-up, so a child's
  registration effect fires *before* `<OrpcWs>`'s own `connect()` effect. The
  handler is in the registry before the connection is even attempted — no race.
- **A registrant gated behind `fallback` mounts one commit LATER — after
  `connected`.** When a `fallback` is set, children mount only once the WS
  reaches `connected`, which is *one React commit after* the socket opened. A
  server push that arrives in that gap — before the gated component's
  registration effect runs — hits a contract-declared procedure with no mounted
  handler and gets a graceful `ORPCError("NOT_FOUND")` back over the wire (the
  core delegating router's behavior). It is handled, not a crash, but the push
  is lost.

**Guidance.** To guarantee a handler is live *before the first server push*,
mount its component **ungated** — a direct child of `<OrpcWs>` not hidden behind
`fallback` — so it registers pre-connect. If you do gate it behind `fallback`
(or otherwise mount it post-connect), the **server** must tolerate an early
`NOT_FOUND`: delay or retry the first server→client call until the client has
had a commit to register. The authless demo takes the gated route on purpose and
pairs it with a ~1s server-side delay before the welcome `showToast`, so the
fallback→child commit always wins the race (see `ServerToasts.tsx` and the
authless server's `app-module.ts`).

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

- **`<OrpcWs {...props}>`** — `props` is `OrpcWsProps`; `TClientContract` is
  inferred from the `clientContract` prop (no explicit generic).
- **`OrpcWsProps<TClientContract>`** — every `createOrpcWsClient` construction
  option **minus** `clientRouter` / `clientContext`, plus: `clientContract?`
  (the server→client contract router value — present turns bidi on, absent
  leaves it off), `fallback?: ReactNode`, and `children: ReactNode`.
- **`createServerHandlerHook<TClientContract>()`** — binds a server→client
  contract and returns a typed `useServerHandler(name, handler)` hook. `name`
  is constrained to the contract's procedure keys; the handler's input /
  output are pinned per procedure (the call itself returns `void`). Call the
  returned hook from any component below `<OrpcWs>`.

### Composing the client contract from feature fragments

The `clientContract` is the central typed surface for the server→client
direction — that's inherent to typed RPC, the way a server router has a single
root. But "central" doesn't mean "monolithic": keep it **thin and
feature-owned** by composing it from per-feature fragments merged at a small
root. Each feature owns its own slice — a plain object of `oc` procedures,
colocated with that feature's component and its `useServerHandler`
registration. Adding a feature is a new fragment file plus one spread line at
the root; you never edit another feature's slice.

```ts
// feature A owns its slice — toast/toast.contract.ts
export const toastClientContract = {
  showToast: oc.input(z.object({ text: z.string() })).output(z.object({ shown: z.boolean() })),
};
// feature B owns its slice — announce/announce.contract.ts
export const announceClientContract = {
  announce: oc.input(z.object({ message: z.string() })).output(z.object({ ok: z.boolean() })),
};
// THIN composition root — just merges the fragments
export const clientContract = oc.router({ ...toastClientContract, ...announceClientContract });
export type ClientContract = typeof clientContract;
```

One `useServerHandler` hook — bound once to the merged `ClientContract` via
`createServerHandlerHook<ClientContract>()` — serves **all** features: many
components, one hook, different procedure names. Each feature's component
registers only its own name (see the `useServerHandler` idiom above).

**Optional: feature-scoped hooks.** A feature can bind its hook to just its own
slice — `createServerHandlerHook<typeof toastClientContract>()` — so that
feature's call sites can't even *see* other features' procedure names. That's
pure type scoping: the hook still registers into the **same**
`<OrpcWs>` / `clientContract` at runtime; the narrowing is a types-only nicety,
not a separate registry.

For a worked example, see `apps/demo-authless`: its
`contract/src/client/*.contract.ts` fragments merge into a thin
`contract/src/index.ts` root, and `<ServerToasts>` + `<Announcements>` each own
a fragment while sharing one `useServerHandler`.

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

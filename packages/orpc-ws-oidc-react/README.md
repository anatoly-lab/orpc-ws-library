# `@repo/orpc-ws-oidc-react`

The library's **React bindings** — hooks and a provider that adapt the
framework-free cores to React. This package contains *only* React glue.
It does **not** re-export the cores; the client and auth factories (and
their types) come straight from `@repo/orpc-ws-client` and
`@repo/oidc-pkce`.

```ts
import { createOrpcWsClient, consoleLogger } from "@repo/orpc-ws-client";
import { createOidcAuth } from "@repo/oidc-pkce";
import {
  useConnectionState,
  useAuthState,
  OrpcWsProvider,
} from "@repo/orpc-ws-oidc-react";

// Construct the framework-free pieces from the cores:
const client = createOrpcWsClient<MyContract>({
  url: "wss://…",
  logger: consoleLogger,
});
const auth = createOidcAuth({ /* … */ });

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
  const authState = useAuthState(auth);
  return <span>{state.status} / {authState.status}</span>;
}
```

## What's here

This package exports the React bindings only:

- **`useConnectionState(client)`** — `useSyncExternalStore` binding to the
  client's reactive connection state.
- **`OrpcWsProvider` / `useOrpcWs()`** — optional context helper for sharing
  one client across the tree. `OrpcWsProviderProps` types the provider.
- **`useAuthState(auth)`** — `useSyncExternalStore` binding to the OIDC
  auth snapshot.
- **`useUser(auth)`** — convenience hook for the current OIDC user.
- **`useOidcCallback(auth, options?)`** — drives the OIDC redirect-back
  exchange once on mount; router-free (see below).
- **`RequireAuth`** — gate component for protected UI. Renders its children
  only when a token is present, else a sign-in fallback; router-free (see
  below).

The optional `./react-router` sub-path adds:

- **`OidcCallback`** — a drop-in callback route component for React
  Router apps. Requires `react-router-dom` as an **optional** peer.

## Handling the OIDC callback

When the IdP redirects back to your app (`/auth/callback?code=…&state=…`),
something has to run the PKCE code-exchange exactly once and then move the
user on. This package offers two surfaces for that — pick by how much glue
you want to write.

### `useOidcCallback` — router-agnostic (main entry)

The hook owns the exchange (StrictMode-safe, runs once) and reports the
outcome as state. You own navigation and UI, so it works with any
router — or none:

```tsx
import { useOidcCallback } from "@repo/orpc-ws-oidc-react";
import { useNavigate } from "react-router-dom";

function CallbackPage() {
  const navigate = useNavigate();
  const { status, error } = useOidcCallback(authClient, {
    onSuccess: () => navigate("/", { replace: true }),
  });

  if (status === "error" && error) {
    return <pre>Sign-in failed: {error.type}</pre>;
  }
  return <p>Signing you in…</p>;
}
```

**Empty-params guard.** If the callback route is hit without an IdP result
in the query string — a direct navigation, a bookmark, or a refresh after
the flow already finished — the hook does nothing and stays `pending`. It
triggers only when `code` (success) **or** `error` (an IdP-reported
failure, e.g. `?error=access_denied`) is present, so genuine IdP errors
still reach your `onError` / `status === "error"` UI.

### `OidcCallback` — React Router drop-in (sub-path)

If you're already on React Router, the sub-path component wires the hook to
`useNavigate` for you — one line in your route table:

```tsx
import { OidcCallback } from "@repo/orpc-ws-oidc-react/react-router";

<Route
  path="/auth/callback"
  element={
    <OidcCallback
      client={authClient}
      navigateTo="/"
      renderError={(e) => <pre>{myFriendlyCopy(e)}</pre>}
    />
  }
/>;
```

Importing this sub-path pulls in `react-router-dom`, which is an
**optional** peer dependency — you only need it installed if you import
`@repo/orpc-ws-oidc-react/react-router`. The main entry never touches it.

## Gating protected UI — `RequireAuth` (main entry)

`RequireAuth` lifts the per-page "are we signed in?" check into one reusable
guard. Wrap a protected subtree — an `<Outlet />`, a page, a section — and it
renders the children only when a token is present, otherwise a `fallback`
sign-in screen.

```tsx
import { RequireAuth } from "@repo/orpc-ws-oidc-react";

function AppLayout() {
  return (
    <RequireAuth client={authClient} fallback={<SignIn />}>
      <Outlet />
    </RequireAuth>
  );
}
```

**Props.** `client` (the `OidcAuth` instance), `children` (the protected
subtree), and an optional `fallback`. When `fallback` is omitted, a minimal,
app-neutral signed-out UI with a sign-in button renders instead — pass your
own to supply branding and copy.

**The `!== "anonymous"` predicate.** Children render whenever a token is
present — i.e. `status` is `authenticated` **or** `expired` — not only when
`authenticated`. An expired session must still render the protected content so
the WS client's reconnect+refresh recovery can run (it sends the stale token,
the server closes with `1008`, and `refresh()` restores the session). Gating
on `=== "authenticated"` would bounce an expiring session back to sign-in
mid-recovery.

**Router-free.** `RequireAuth` gates an arbitrary `ReactNode`, so it never
imports a router and lives in the main entry. Use it with React Router (wrap an
`<Outlet />`), any other router, or none (wrap a page directly).

## Tradeoffs & alternatives

The callback flow ships as two surfaces on purpose:

| | `OidcCallback` (sub-path) | `useOidcCallback` (hook) |
| --- | --- | --- |
| Glue you write | One `<Route>` line | ~10 lines (navigate + UI) |
| Router | React Router only | Any router, or none |
| Extra dependency | `react-router-dom` (optional peer) | none |
| Import | `…/react-router` | main entry |

**Why the split.** The hook is the honest framework-agnostic primitive: it
has no router dependency, so it can't drag one into apps that use a
different router (TanStack Router, wouter, plain `window.location`). The
React Router binding is real convenience, but it pulls a concrete
framework — so it lives behind a sub-path import and an optional peer,
keeping the package's main entry router-free. This matches the CLAUDE.md
sub-path rule (same browser runtime + peer-only dependency); the framework
binding never leaks into the core surface.

**No logic divergence.** `OidcCallback` is a thin wrapper that calls
`useOidcCallback` internally and feeds its `onSuccess` to `useNavigate`.
The exchange, the StrictMode-once guard, and the empty-params guard all
live in the hook — there is one implementation, exercised by both surfaces.

## Where the rest lives

The framework-free APIs are imported **directly from the cores** — this
package does not wrap or re-export them:

- **`@repo/orpc-ws-client`** — the WS client core: `createOrpcWsClient`,
  `consoleLogger`, `ConnectionState`, `OrpcWsClient`, config, logger
  bridges, …
- **`@repo/oidc-pkce`** — the browser OIDC + PKCE core: `createOidcAuth`,
  `CallbackError`, `AuthSnapshot`, `OidcUser`, `AuthStatus`, …

Keeping this package React-only keeps the layering honest: each core stays
the single source of its own public surface, and future framework adapters
(`-svelte`, `-vue`, `-solid`) follow the same rule — framework bindings
only, no core re-exports.

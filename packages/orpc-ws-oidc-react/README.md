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

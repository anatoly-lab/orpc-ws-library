# `@repo/oidc-pkce`

Browser OIDC + PKCE auth helper. Vanilla TypeScript, zero runtime deps,
no framework coupling. Uses OIDC Discovery so it works against any
compliant IdP — Keycloak, Auth0, Okta, Cognito, Google. Produces a
`TokenProvider` structurally compatible with `@repo/orpc-ws-client`.

## Install

```bash
npm install @repo/oidc-pkce
```

## Quickstart

```ts
// src/lib/auth.ts
import { createOidcAuth } from "@repo/oidc-pkce";

export const auth = createOidcAuth({
  issuerUrl: import.meta.env.VITE_OIDC_ISSUER_URL,
  clientId: import.meta.env.VITE_OIDC_CLIENT_ID,
  redirectUri: `${window.location.origin}/auth/callback`,
  scopes: ["openid", "email", "profile"],
});

// Optional: warm up discovery so first redirect doesn't pay the round-trip.
void auth.prefetchMetadata();
```

Wire into the ORPC client:

```ts
import { createOrpcWsClient } from "@repo/orpc-ws-client";
import { auth } from "./auth.js";

export const wsClient = createOrpcWsClient<AppContract>({
  url: import.meta.env.VITE_WS_URL,
  tokenProvider: auth.tokenProvider, // structurally compatible
  onTerminalAuthFailure: () => auth.clearTokens(),
});
```

In your callback route:

```ts
const result = await auth.handleCallback(
  new URLSearchParams(window.location.search),
);
if (!result.ok) return console.error(result.error);
wsClient.connect();
```

## API

```ts
interface OidcConfig {
  /**
   * OIDC issuer URL. Examples:
   *   Keycloak: https://<host>/realms/<realm>
   *   Auth0:    https://<tenant>.auth0.com/  (trailing slash matters)
   *   Okta:     https://<tenant>.okta.com/oauth2/<asid>
   *   Google:   https://accounts.google.com
   */
  issuerUrl: string;
  clientId: string;
  redirectUri: string;          // e.g. `${origin}/auth/callback`
  scopes?: string[];            // default ["openid", "email", "profile"]
}

interface OidcAuth {
  redirectToLogin(): Promise<void>;
  handleCallback(searchParams: URLSearchParams): Promise<CallbackResult>;
  logout(opts?: { redirectTo?: string }): Promise<void>;

  hasToken(): boolean;
  isAccessTokenValid(): boolean;
  getAuthStatus(): "authenticated" | "expired" | "anonymous";
  getUser(): OidcUser | null;
  clearTokens(): void;

  prefetchMetadata(): Promise<void>;

  tokenProvider: TokenProvider;
}
```

`OidcUser` carries the four standard OIDC claims (`sub`, `email`,
`name`, `preferredUsername`). IdP-specific claims (Keycloak's
`realm_access.roles`, etc.) — parse from `id_token` yourself.

Discovery is fetched on first auth-method call and cached for the page
lifetime, keyed by `issuerUrl` (shared across multiple `createOidcAuth`
instances against the same issuer; concurrent first-calls share one
in-flight fetch). The library asserts the `issuer` field in the
discovery document matches the configured `issuerUrl`. Discovery
failures throw `OidcDiscoveryError`; `logout()` clears local tokens
anyway.

`tokenProvider.getToken()` returns the stored access token AS-IS
(possibly expired) so the client's stale-token-then-1008-then-refresh
flow works. `refresh()` is pure: returns the new token or `null` on
failure. Consumer-side cleanup happens in `onTerminalAuthFailure` on
the client side. See [`@repo/orpc-ws-client`](../orpc-ws-client/README.md)
for the full `TokenProvider` contract.

## Storage

Tokens persist to `localStorage` under `oidc.tokens` by default. Plug
in your own:

```ts
import type { Storage } from "@repo/oidc-pkce";

const inMemory: Storage = (() => {
  let t: Tokens | null = null;
  return { read: () => t, write: (n) => { t = n; }, clear: () => { t = null; } };
})();

const auth = createOidcAuth(config, { storage: inMemory });
```

PKCE verifier/state always live in `sessionStorage` — not pluggable.
The one-tab, one-flow lifetime is a protocol security property.

## Edge cases

- **React StrictMode callback.** `handleCallback` consumes PKCE state
  on read. Guard the effect with a `useRef` so StrictMode's
  double-invoke doesn't state-mismatch the second call.
- **Refresh-token rotation disabled.** Refresh responses without
  `refresh_token` / `id_token` carry through the stored values — no
  reconfiguration needed.
- **No `end_session_endpoint`.** `logout()` clears local tokens and
  returns; consumer routes wherever they like.
- **Default `localStorage` exposes tokens to same-origin JS** (incl.
  XSS). For stricter requirements: swap in an in-memory `Storage`
  (loses persistence on reload), or move to httpOnly session cookies
  via a BFF (omit `tokenProvider` on the client — cookie auth works
  out of the box).

## See also

- Top-level [README](../../README.md)
- [`@repo/orpc-ws-client`](../orpc-ws-client/README.md) — paired client (consumes `tokenProvider`)
- [`@repo/oidc-verifier-jose`](../oidc-verifier-jose/README.md) — server-side counterpart
- [src/index.ts](./src/index.ts) — full export surface

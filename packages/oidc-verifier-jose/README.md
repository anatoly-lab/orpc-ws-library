# `@orpc-ws/oidc-verifier-jose`

Server-side OIDC access-token verifier. Uses OIDC Discovery so it works
against any compliant IdP — Keycloak, Auth0, Okta, Cognito, Microsoft.
Produces a `VerifyClient` callback that drops directly into
`@orpc-ws/server`'s `verifyClient` option.

Node-only. The browser-side counterpart is
[`@orpc-ws/oidc-pkce`](../oidc-pkce/README.md).

## Install

```bash
npm install @orpc-ws/oidc-verifier-jose
```

`jose` is a direct dependency.

## Quickstart

```ts
import { createOidcVerifyClient } from "@orpc-ws/oidc-verifier-jose";
import { OrpcWsServer } from "@orpc-ws/server";

const verifyClient = createOidcVerifyClient({
  issuerUrl: "https://auth.example.com/realms/demo",
  boundClaim: "azp",          // see table below
  expectedClientId: "spa",
});

const server = new OrpcWsServer({
  router: appRouter,
  verifyClient,
  connection: { path: "/ws" },
});
```

The factory is sync; discovery + JWKS fetches are deferred to the
first verify, then cached for the process lifetime.

## `boundClaim` — provider table

Different IdPs put the client-id binding in different claims:

| Provider              | `boundClaim` |
| --------------------- | ------------ |
| Keycloak              | `"azp"`      |
| Microsoft v1          | `"azp"`      |
| Auth0                 | `"aud"`      |
| Okta                  | `"aud"`      |
| Cognito               | `"aud"`      |
| Google                | `"aud"`      |
| Sender-constrained    | `false`      |

No auto-detection — the failure mode is silent acceptance across the
wrong client. The consumer makes this explicit. Default is `"azp"`.

## API

```ts
function createOidcVerifyClient<TUser = OidcUser>(
  cfg: OidcVerifierConfig,
  mapUser?: (payload: JWTPayload) => TUser,
): VerifyClient<TUser>;

interface OidcVerifierConfig {
  issuerUrl: string;                    // PUBLIC OIDC issuer; same value the SPA uses
  discoveryUrl?: string;                // INTERNAL base to fetch discovery/JWKS from
                                        // (defaults to issuerUrl — see below)
  boundClaim?: BoundClaim;              // "azp" (default) | "aud" | false
  expectedClientId?: string;            // required when boundClaim != false
  verifyClaims?: (payload: JWTPayload)  // escape hatch (scope/tenant/role)
    => boolean | Promise<boolean>;      // return false (or throw) to reject
}

type BoundClaim = "azp" | "aud" | false;

interface OidcUser {                    // default mapUser shape
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}
```

Custom `mapUser` example:

```ts
createOidcVerifyClient<AppUser>(cfg, (payload) => ({
  id: payload.sub as string,
  email: payload["email"] as string,
  roles: (payload["realm_access"] as { roles?: string[] })?.roles ?? [],
}));
```

`connectionKey` (registry key for one-connection-per-user, 4005
kicked-on-replace) is derived from the verified `payload.sub`
**independent of `mapUser`** — a custom mapper can't accidentally break
session replacement by dropping `sub`. Discovery is cached at the
module level, keyed by the `(fetch URL, expected issuer)` pair (which
collapses to per-`issuerUrl` keying when `discoveryUrl` is unset);
concurrent first-callers share one in-flight promise; failed promises
are evicted so a transient blip doesn't poison the cache.

## `discoveryUrl` — split internal/public IdP URLs

For deployments where the server reaches the IdP over a different host
than the browser does — container networking (docker-compose /
Testcontainers e2e), a reverse proxy, or a BFF:

```ts
createOidcVerifyClient({
  // What the browser uses, and what the IdP signs into tokens' `iss`.
  issuerUrl: "http://localhost:18080/realms/demo",
  // What THIS server can actually reach (e.g. a docker hostname).
  discoveryUrl: "http://keycloak:8080/realms/demo",
  boundClaim: "azp",
  expectedClientId: "spa",
});
```

- **Fetching** (discovery doc + JWKS) goes to `discoveryUrl`. If the
  advertised `jwks_uri` starts with `issuerUrl`, that prefix is
  rewritten to `discoveryUrl` so the JWKS fetch is internally
  reachable too; a `jwks_uri` on any other host is used as-is.
- **Validation is unchanged**: the discovery document's `issuer` and
  every token's `iss` claim are still asserted against the public
  `issuerUrl`. This requires the IdP to advertise its public issuer
  even on the internal host (Keycloak: pin `KC_HOSTNAME` to the
  public URL).
- **Default**: `discoveryUrl` falls back to `issuerUrl` — omitting it
  is byte-identical to the pre-`discoveryUrl` behavior.

## Edge cases

- **All rejections surface as `{ ok: false, code: 401, reason }`.**
  401 is the pre-101 HTTP handshake-abort status (NOT a WS close code —
  Node's HTTP reject path throws on out-of-range status codes); the
  client sees a pre-101 HTTP rejection rather than an
  opened-then-closed socket.
- **Discovery failures don't crash the server.** `OidcDiscoveryError`
  is caught and reported as a rejection — the server rejects
  connections until the IdP recovers.
- **`issuerUrl` must match the IdP's signed `iss` claim.** Common
  misconfig: SPA uses the public URL while the IdP signs with an
  internal-network URL. The library asserts equality. If the *server*
  merely *reaches* the IdP over an internal URL (while tokens carry the
  public issuer), that's the `discoveryUrl` case above — not this one.

## See also

- Top-level [README](../../README.md)
- [`@orpc-ws/server`](../orpc-ws-server/README.md) — paired server (consumes `VerifyClient`)
- [`@orpc-ws/oidc-pkce`](../oidc-pkce/README.md) — browser-side counterpart
- [src/index.ts](./src/index.ts) — full export surface

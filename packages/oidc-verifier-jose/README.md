# `@repo/oidc-verifier-jose`

Server-side OIDC access-token verifier. Uses OIDC Discovery so it works
against any compliant IdP — Keycloak, Auth0, Okta, Cognito, Microsoft.
Produces a `VerifyClient` callback that drops directly into
`@repo/orpc-ws-server`'s `verifyClient` option.

Node-only. The browser-side counterpart is
[`@repo/oidc-pkce`](../oidc-pkce/README.md).

## Install

```bash
npm install @repo/oidc-verifier-jose
```

`jose` is a direct dependency.

## Quickstart

```ts
import { createOidcVerifyClient } from "@repo/oidc-verifier-jose";
import { OrpcWsServer } from "@repo/orpc-ws-server";

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
  issuerUrl: string;                    // OIDC issuer; same value the SPA uses
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
module level, keyed by `issuerUrl`; concurrent first-callers share one
in-flight promise; failed promises are evicted so a transient blip
doesn't poison the cache.

## Edge cases

- **All rejections surface as `{ ok: false, code: 4001, reason }`.**
  4001 is the WS auth-failed close code; the client sees a pre-101 HTTP
  rejection rather than an opened-then-closed socket.
- **Discovery failures don't crash the server.** `OidcDiscoveryError`
  is caught and reported as a rejection — the server rejects
  connections until the IdP recovers.
- **Issuer URL must match the IdP's signed `iss` claim.** Common
  misconfig: SPA uses the public URL while the IdP signs with an
  internal-network URL. The library asserts equality.

## See also

- Top-level [README](../../README.md)
- [`@repo/orpc-ws-server`](../orpc-ws-server/README.md) — paired server (consumes `VerifyClient`)
- [`@repo/oidc-pkce`](../oidc-pkce/README.md) — browser-side counterpart
- [src/index.ts](./src/index.ts) — full export surface

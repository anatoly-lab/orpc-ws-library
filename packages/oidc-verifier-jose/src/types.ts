// Public types for `@repo/oidc-verifier-jose`.
//
// Symmetric to `@repo/oidc-pkce` (browser side): both packages share
// the same OIDC Discovery primitive shape and `OidcUser` field set, but
// the verifier lives in Node-only territory because `jose`'s
// `createRemoteJWKSet` + `jwtVerify` are heavy enough that pulling them
// into the SPA's bundle is undesirable.
//
// One concept per file (CLAUDE.md "No god files"). This module owns
// only the type surface — no fetch, no defaults, no factory. Composition
// happens in `client.ts`.

import type { JWTPayload } from "jose";

/**
 * Minimal subset of the OIDC Discovery document the server actually
 * consumes.
 *
 * Other standard fields (`authorization_endpoint`, `token_endpoint`,
 * etc.) are SPA-side concerns. The server only needs `issuer` for the
 * issuer-claim assertion in `jwtVerify` and `jwks_uri` to feed
 * `createRemoteJWKSet`.
 */
export interface OidcMetadata {
  issuer: string;
  jwks_uri: string;
}

/**
 * Which JWT claim binds an access token to a specific OIDC client.
 *
 * Different IdPs use different claims; pick the one your provider
 * actually populates:
 *
 * - `"azp"` — Keycloak (and Microsoft v1 access tokens). Keycloak's
 *   `aud` is `["account"]` by default, so the client-id binding lives
 *   in `azp` ("authorized party"). RFC 8693 §3.
 * - `"aud"` — Auth0, Okta, Cognito, most spec-compliant IdPs. The
 *   token's `aud` claim must contain `expectedClientId`. Handles both
 *   the string form (`"abc"`) and the array form (`["abc","def"]`).
 * - `false` — disable the client-binding check entirely. Only correct
 *   when the upstream already validates client binding through another
 *   mechanism (mTLS, PoP / DPoP, sender-constrained tokens). Most apps
 *   should NOT pick this.
 *
 * No "auto-detect" because the failure mode is silent token acceptance
 * across the wrong client — the consumer makes this explicit.
 */
export type BoundClaim = "azp" | "aud" | false;

/**
 * Static configuration of the verifier.
 *
 * Pure data — no fetch, no factories. The composition root
 * (`createOidcVerifyClient`) decides how this gets wired.
 */
export interface OidcVerifierConfig {
  /**
   * OIDC issuer URL — the server fetches
   * `${issuerUrl}/.well-known/openid-configuration` once on first
   * verify, caches the result, and reads `issuer` + `jwks_uri` from
   * there. Same value the SPA's `@repo/oidc-pkce` uses.
   *
   * A single trailing slash is tolerated; the library normalizes it
   * before joining the discovery path AND before comparing the
   * returned `issuer` claim.
   */
  issuerUrl: string;

  /**
   * Claim that binds the token to a specific OIDC client. See
   * `BoundClaim` for per-IdP guidance.
   *
   * Default: `"azp"`. The Keycloak default; consumers on other IdPs
   * (Auth0 / Okta / Cognito / etc.) MUST set `"aud"` explicitly.
   */
  boundClaim?: BoundClaim;

  /**
   * The OIDC client_id the token must be bound to. REQUIRED when
   * `boundClaim` is `"azp"` or `"aud"` (the factory throws if absent
   * — config-time failure is loud and stops a misconfigured server
   * from booting). Unused when `boundClaim` is `false`.
   */
  expectedClientId?: string;

  /**
   * Escape hatch for additional verification (scope checks, custom
   * tenant binding, etc). Runs after the issuer / signature / boundClaim
   * checks pass. Return `false` to reject; the rejection surfaces as
   * `code: 4001, reason: "Custom claim validation failed"`.
   *
   * Throwing from this callback is also a rejection — the thrown
   * message becomes the close `reason`.
   */
  verifyClaims?: (payload: JWTPayload) => boolean | Promise<boolean>;
}

/**
 * Display-friendly view of the authenticated subject, parsed from the
 * verified JWT payload.
 *
 * Only the four standard OIDC claims are surfaced. IdP-specific claims
 * (Keycloak's `realm_access.roles`, Auth0's `https://...` custom
 * namespaces) are NOT parsed here — consumers needing them pass a
 * custom `mapUser` to `createOidcVerifyClient` and pick out what they
 * want from the raw `JWTPayload`.
 *
 * Field set matches `@repo/oidc-pkce`'s `OidcUser` shape so consumers
 * can keep one `User`-flavored type across the SPA and the API.
 */
export interface OidcUser {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}

/**
 * Thrown by `fetchMetadata` when the discovery document cannot be
 * loaded or fails validation. The verify callback catches it and
 * surfaces it as a `{ ok: false, code: 4001, reason: ... }` rejection
 * — boot-time discovery failures don't crash the server; they just
 * reject every connection until the IdP comes back.
 */
export class OidcDiscoveryError extends Error {
  constructor(
    message: string,
    public readonly details: {
      issuerUrl: string;
      status?: number;
      body?: string;
    },
  ) {
    super(message);
    this.name = "OidcDiscoveryError";
  }
}

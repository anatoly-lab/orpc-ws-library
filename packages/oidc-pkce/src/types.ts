// Public types for `@repo/oidc-pkce`.
//
// One concept per file (CLAUDE.md "No god files"). This module owns ONLY
// the type surface — no logic, no defaults, no factory. Everything else
// (PKCE, fetch, storage wiring) is composed in `client.ts`.
//
// `TokenProvider` is **duplicated locally** rather than imported from
// `@repo/orpc-ws-client`. Rationale:
//   - Keeps this package's dependency graph empty at runtime (zero deps).
//   - The two interfaces are structurally identical; TypeScript's
//     structural typing means the returned `tokenProvider` is assignable
//     to `@repo/orpc-ws-client`'s `TokenProvider` without any explicit
//     conversion.
//   - If the upstream contract ever drifts, this package fails at the
//     consumer's compile site (where they wire the two together) — that's
//     the right place for the loud error, not here.

/**
 * Static configuration of an OIDC issuer + client.
 *
 * `issuerUrl` is the canonical OIDC issuer URL. The library appends
 * `/.well-known/openid-configuration` to fetch the discovery document
 * (RFC 8414 / OIDC Discovery 1.0 §4) and extracts the authorize / token /
 * end-session / JWKS endpoints from there.
 *
 * Pure data. No clock, no fetch, no storage. The composition root
 * (`createOidcAuth`) decides how this gets wired with the rest.
 */
export interface OidcConfig {
  /**
   * OIDC issuer URL — e.g. `"https://auth.example.com/realms/x"` for
   * Keycloak, `"https://accounts.google.com"` for Google, etc. The
   * library tolerates a single trailing slash; discovery is built as
   * `${stripTrailingSlash(issuerUrl)}/.well-known/openid-configuration`.
   */
  issuerUrl: string;
  /** Public client ID configured with the IdP — e.g. `"orpc-ws-demo-spa"`. */
  clientId: string;
  /**
   * Redirect URI registered on the IdP client. The library passes
   * this through to both the `/auth` redirect and the `/token` exchange,
   * so it MUST match the value the IdP has stored.
   */
  redirectUri: string;
  /**
   * OIDC scopes — defaults to `["openid", "email", "profile"]` when
   * omitted. Order matters only insofar as it's joined with spaces and
   * sent to the IdP verbatim.
   */
  scopes?: string[];
}

/**
 * Parsed OIDC discovery document
 * (`.well-known/openid-configuration`).
 *
 * Only the endpoints we actually use are required. Other standard
 * fields (`jwks_uri`, `userinfo_endpoint`, etc.) are typed but not
 * enforced — consumers may inspect them if they want to do their own
 * id-token signature verification or userinfo lookup.
 */
export interface OidcMetadata {
  /**
   * The issuer identifier the IdP signs into id-tokens. MUST match the
   * configured `issuerUrl` (after a single-trailing-slash normalization
   * on both sides) — mismatch surfaces a misconfigured public-URL vs.
   * internal-URL split early, instead of as opaque "invalid_token"
   * errors later.
   */
  issuer: string;
  /** OIDC authorization endpoint — where `redirectToLogin` sends the browser. */
  authorization_endpoint: string;
  /** OIDC token endpoint — POST target for code-exchange and refresh. */
  token_endpoint: string;
  /** JWKS endpoint — reserved for future signature verification. */
  jwks_uri: string;
  /**
   * End-session endpoint. Optional — not every IdP exposes one (the spec
   * is OIDC Session Management, an extension). When absent, `logout()`
   * clears local tokens but does not redirect to the IdP.
   */
  end_session_endpoint?: string;
  /** Userinfo endpoint — typed for completeness; library does not use it. */
  userinfo_endpoint?: string;
}

/**
 * Token bundle returned from a successful auth or refresh exchange.
 *
 * `expiresAt` is an ABSOLUTE millisecond timestamp (`Date.now()`-relative).
 * The IdP returns `expires_in` (seconds, relative); we convert at the
 * boundary so every other module reasons in absolute time.
 */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** Absolute ms timestamp at which the access token expires. */
  expiresAt: number;
}

/**
 * Display-friendly view of the authenticated subject, parsed from the
 * id_token's JWT payload.
 *
 * Only the four standard OIDC claims are surfaced. IdP-specific claims
 * (Keycloak's `realm_access.roles`, Auth0's `https://...` custom
 * namespaces, etc.) are NOT parsed here — consumers who need them call
 * `parseJwt(authClient.getTokens().idToken)` themselves and pick out
 * what they want. Keeps this package OIDC-generic.
 */
export interface OidcUser {
  sub: string;
  email?: string;
  name?: string;
  preferredUsername?: string;
}

/**
 * Coarse-grained auth state for UI gating.
 *
 * - `anonymous`: no token in storage.
 * - `expired`: token in storage but past `expiresAt`.
 * - `authenticated`: token in storage and not yet expired.
 *
 * The `expired` state is distinct from `anonymous` so consumers can show
 * "session expired, please log in again" rather than the initial-login
 * UI. The ws-client's `tokenProvider.refresh()` will still try to
 * recover an expired session before the consumer falls back to forcing
 * a fresh login.
 */
export type AuthStatus = "authenticated" | "expired" | "anonymous";

/**
 * Discriminated-union error for the callback flow. Keep specific so the
 * UI can show actionable messages rather than a single "auth failed"
 * lump.
 *
 * `idp_error` carries the OAuth 2.0 authorization-response error
 * (§4.1.2.1): the IdP redirected back with `?error=...&error_description=...`
 * instead of `?code=...`. Provider-agnostic — the wire format is the
 * same across Keycloak, Auth0, Okta, etc.
 */
export type CallbackError =
  | { type: "state_mismatch" }
  | { type: "missing_code" }
  | { type: "exchange_failed"; status: number; body: string }
  | { type: "idp_error"; error: string; description?: string };

/** Discriminated-union result of `handleCallback`. */
export type CallbackResult =
  | { ok: true; user: OidcUser; tokens: Tokens }
  | { ok: false; error: CallbackError };

/**
 * Pluggable storage for TOKENS only.
 *
 * Why pluggable: localStorage is the sane default for browser-SPA demos,
 * but it exposes tokens to XSS. Consumers who want a tighter posture
 * (in-memory only, IndexedDB with a worker, httpOnly cookie + BFF) plug
 * their own implementation in here.
 *
 * Why NOT pluggable for PKCE state: the PKCE verifier+state pair are
 * a one-tab, one-flow concern that MUST disappear when the tab closes.
 * sessionStorage gives exactly that behavior; allowing pluggable storage
 * for PKCE would invite a consumer to put it in localStorage by mistake
 * and create a per-issuer CSRF foot-gun. Hard-coded in `flow.ts`.
 */
export interface Storage {
  /** Read the persisted tokens, or `null` if nothing is stored. */
  read(): Tokens | null;
  /**
   * Persist tokens. Implementations MUST overwrite any prior bundle —
   * the library never expects partial-write semantics.
   */
  write(tokens: Tokens): void;
  /**
   * Remove the tokens from storage. Idempotent — safe to call on an
   * empty storage.
   */
  clear(): void;
}

/**
 * Consumer-facing token provider. Structurally compatible with
 * `@repo/orpc-ws-client`'s `TokenProvider` (the wire-up site type-checks
 * the match). Duplicated locally to keep this package dep-free.
 *
 * - `getToken()`: synchronous read. Returns the stored access token
 *   AS-IS — does NOT consult expiry, does NOT refresh. The ws-client
 *   intentionally calls this on every reconnect attempt to grab the
 *   latest token, and the library's reconnect+refresh dance assumes
 *   `getToken()` is dumb: send stale token, get 1008, then call
 *   `refresh()`.
 *
 * - `refresh()`: asynchronous. Awaits discovery if not yet fetched,
 *   then hits the IdP token endpoint with the stored refresh token.
 *   On success: writes the new tokens to Storage and returns the new
 *   access token. On failure: returns `null` and does NOT mutate any
 *   state (CLAUDE.md "Auth flow contract" purity guarantee — see
 *   `bug-refresh-purity.test.ts`).
 */
export interface TokenProvider {
  getToken(): string | null;
  refresh(): Promise<string | null>;
}

/**
 * Thrown by `fetchMetadata` when the discovery document cannot be
 * loaded or fails validation. The composition root does NOT catch this
 * — `redirectToLogin()` etc. propagate the throw so the consumer sees
 * the failure in UI rather than silently mis-configuring.
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

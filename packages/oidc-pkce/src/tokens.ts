// Token-endpoint exchanges + JWT parsing.
//
// Pure-ish: takes metadata + fetch as arguments. The default `fetch`
// from `globalThis` is the runtime path; tests inject a fake via
// `vi.spyOn(globalThis, "fetch")`. No module-level state.
//
// `expiresAt` math uses `Date.now()` directly. This is intentional and
// CORRECT: the locked public API has no clock seam, and `vi.useFakeTimers
// ({ toFake: ["Date"] })` already fakes `Date.now()` for deterministic
// tests (see `vitest.config.base.ts`). Re-introducing a Clock interface
// here would just be ceremony.

import type { OidcMetadata, OidcUser, Tokens } from "./types.js";

/**
 * Raw OIDC token-endpoint response. IdPs omit `refresh_token` and
 * `id_token` for some grant types, but for `authorization_code` and
 * `refresh_token` (the two we issue) they return both. We mark them
 * optional defensively and validate at the boundary.
 */
interface OidcTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

/**
 * Minimal id-token JWT payload shape. Many other claims may be present
 * (and many IdPs add their own non-standard ones — Keycloak's
 * `realm_access.roles`, Auth0's custom-namespace claims, etc.); we
 * explicitly only look at the standard OIDC claims consumed by
 * `OidcUser`. Consumers needing IdP-specific claims parse the
 * id_token themselves via `parseJwt`.
 */
interface IdTokenPayload {
  sub?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}

/**
 * Convert an OIDC token-response into the library's absolute-time
 * `Tokens` bundle. Falls back to a 5-minute expiry if the IdP omits
 * `expires_in` (defensive; in practice every IdP sends it).
 *
 * Requires `refresh_token` and `id_token` to be present — both are
 * needed downstream (refresh for `tokenProvider.refresh()`, id_token
 * for `OidcUser`). Throws if either is missing; the caller
 * translates the throw into a `CallbackError`.
 */
export function tokenResponseToBundle(resp: OidcTokenResponse): Tokens {
  if (!resp.refresh_token) {
    throw new Error(
      "OIDC token response missing refresh_token (client misconfigured? confidential client?)",
    );
  }
  if (!resp.id_token) {
    throw new Error(
      "OIDC token response missing id_token (scope 'openid' missing?)",
    );
  }
  const ttlSeconds = resp.expires_in ?? 300;
  return {
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token,
    idToken: resp.id_token,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
}

/**
 * Decode a JWT's payload WITHOUT verifying the signature. Display-only:
 * the server is the only place that trusts the token's contents.
 *
 * Returns `null` on any structural problem (not a 3-part JWT, payload
 * isn't valid base64url, payload isn't valid JSON). This is deliberately
 * permissive — a malformed token is the user's auth being broken, not
 * a library bug to throw on.
 */
export function parseJwt(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    // base64url -> base64 for `atob`.
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    // `atob` tolerates missing padding in browsers; we don't need to pad.
    return JSON.parse(atob(normalized)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Parse an id_token into an `OidcUser`. Returns `null` if the token
 * is structurally invalid; the caller should treat that as "no user"
 * rather than crashing.
 *
 * Only the four standard OIDC claims are surfaced. IdP-specific claims
 * (Keycloak's `realm_access.roles`, Auth0 custom namespaces, etc.) are
 * NOT extracted here — the package is OIDC-generic by design.
 */
export function parseIdToken(idToken: string): OidcUser | null {
  const payload = parseJwt(idToken) as IdTokenPayload | null;
  if (!payload || typeof payload.sub !== "string") return null;
  const user: OidcUser = { sub: payload.sub };
  if (typeof payload.email === "string") user.email = payload.email;
  if (typeof payload.name === "string") user.name = payload.name;
  if (typeof payload.preferred_username === "string") {
    user.preferredUsername = payload.preferred_username;
  }
  return user;
}

/**
 * True iff the token has passed its `expiresAt` instant. Pure function
 * of the bundle + current time; uses `Date.now()` so fake timers work.
 */
export function isTokenExpired(tokens: Tokens): boolean {
  return Date.now() >= tokens.expiresAt;
}

/**
 * POST the authorization-code grant to the token endpoint. Returns the
 * parsed `Tokens` bundle on 2xx, or a structured error on non-2xx.
 *
 * Throws on network failure (caller treats as `exchange_failed` with
 * status 0 — see `flow.ts`).
 */
export async function exchangeCodeForTokens(args: {
  metadata: OidcMetadata;
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<
  | { ok: true; tokens: Tokens }
  | { ok: false; status: number; body: string }
> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.codeVerifier,
  });
  const resp = await fetch(args.metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false, status: resp.status, body: text };
  }
  const json = (await resp.json()) as OidcTokenResponse;
  return { ok: true, tokens: tokenResponseToBundle(json) };
}

/**
 * POST the refresh-token grant. Returns the parsed `Tokens` bundle on
 * 2xx, or `null` on any failure (non-2xx, network error, or response
 * shape problem).
 *
 * Why null-on-failure (no error object): `refresh()` is the inner
 * function of `TokenProvider.refresh()`, whose contract is exactly
 * `Promise<string | null>`. Surfacing a structured error here would
 * leak through to consumers via Storage writes that didn't happen,
 * and the calling code can't act on it differently anyway — failure
 * means "session is dead, kick the storm guard".
 *
 * `prior` is the currently-stored bundle. We fall back to its
 * `refreshToken` / `idToken` if the IdP response omits them — some
 * IdP configurations (e.g. Keycloak with "Revoke Refresh Token"
 * disabled) return only the access_token on refresh. Without this
 * fallback the SPA would hit terminal auth failure on the first
 * refresh of a non-rotating realm.
 */
export async function refreshTokens(args: {
  metadata: OidcMetadata;
  clientId: string;
  prior: Tokens;
}): Promise<Tokens | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: args.clientId,
    refresh_token: args.prior.refreshToken,
  });
  try {
    const resp = await fetch(args.metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as OidcTokenResponse;
    // Inline the bundle conversion so we can fall back to prior tokens
    // for the rotation-disabled case. `tokenResponseToBundle` stays
    // strict for the initial code-exchange path where both must be
    // present.
    if (!json.access_token) return null;
    const ttlSeconds = json.expires_in ?? 300;
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? args.prior.refreshToken,
      idToken: json.id_token ?? args.prior.idToken,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
  } catch {
    return null;
  }
}

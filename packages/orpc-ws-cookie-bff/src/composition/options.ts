// Public config for the cookie-BFF core (§D.7).
//
// Follows the CANONICAL §D.7 `cookies: { sessionCookieName?, sameSite?,
// secure?, hostPrefix?, cookieMaxAge? }` shape (NOT the stale §K′
// `cookie: { maxAgeSeconds }` sketch).

import type { Clock, Logger } from "@orpc-ws/shared";

import type { Fetcher } from "../oidc/discovery.js";
import type { PkceStore } from "../oidc/pkce-store.js";
import type { IdTokenClaims } from "../oidc/claims.js";
import type { OidcTokenSet } from "../oidc/code-exchange.js";
import type { SessionStore } from "../session-store.js";
import type { CipherKeyInput } from "../crypto/token-cipher.js";

/**
 * Fire-and-forget auth-flow metrics hooks (§D.7). Each is OPTIONAL and called
 * by the `/auth/*` handlers on its path. They are best-effort: every call is
 * wrapped in try/catch and a throw is logged (via the injected `Logger`) but
 * NEVER breaks the auth flow — the same defensive contract as session-slide.
 * Use them for metrics / audit logging, not for control flow.
 */
export interface AuthEvents<TUser> {
  /** `GET /auth/login` was hit (a login flow is starting). */
  onLoginStart?(): void;
  /** `/auth/callback` succeeded — the enriched user that was just stored. */
  onCallbackSuccess?(user: TUser): void;
  /**
   * `/auth/callback` rejected/threw — reason (state mismatch, missing code,
   * code-exchange error, id_token missing subject, …).
   */
  onCallbackFailure?(reason: string): void;
  /** `/auth/logout` deleted the session — `sub` of the ended session, or null. */
  onLogout?(sub: string | null): void;
}

/** IdP / OAuth-client identity. */
export interface KeycloakOptions {
  /** Public issuer (matches token `iss`). */
  issuerUrl: string;
  /** Internal discovery/JWKS base; defaults to `issuerUrl`. */
  discoveryUrl?: string;
  clientId: string;
  /** Present ⇒ confidential client. */
  clientSecret?: string;
  /** Trusted absolute callback URI (api.example/auth/callback) — NOT Host-derived. */
  redirectUri: string;
  /** OAuth scope; default "openid profile email" (NOT offline_access). */
  scope?: string;
  /** RP-initiated-logout post-redirect; defaults to the SPA redirect origin. */
  postLogoutRedirectUri?: string;
  /**
   * Extra query params merged into the authorize URL (e.g. `prompt`,
   * `login_hint`, `max_age`, `acr_values`, `ui_locales`). These are applied
   * FIRST; the 7 security-critical params (`response_type`, `client_id`,
   * `redirect_uri`, `scope`, `state`, `code_challenge`,
   * `code_challenge_method`) are set AFTER and ALWAYS win — a consumer cannot
   * clobber the PKCE / state / redirect params via this map (§F3).
   */
  authorizeParams?: Record<string, string>;
}

/**
 * Endpoint paths. FORWARDED-CONFIG placeholder: the core does not route — these
 * are for an adapter (e.g. the NestJS controller mounts at `basePath`) to
 * consume. Setting them does not change core handler behavior.
 */
export interface EndpointOptions {
  /** Auth route base; default "/auth". */
  basePath?: string;
  /** WS path; default "/ws". */
  ws?: string;
}

/** Cookie hardening (CANONICAL §D.7 shape). */
export interface CookieOptions {
  /** Session cookie name; default "__Host-sid". */
  sessionCookieName?: string;
  /** Default "strict" (Decision #7). */
  sameSite?: "lax" | "strict";
  /** Default true. */
  secure?: boolean;
  /** Default true; enforces __Host- invariants (Secure, Path=/, no Domain). */
  hostPrefix?: boolean;
  /** Persistent Max-Age in seconds; default = sessionTtlSeconds (30d). */
  cookieMaxAge?: number;
}

/**
 * Refresh policy (§F). FORWARDED-CONFIG placeholder: the core does NOT consult
 * `strategy` to change behavior on its own — refresh is invoked imperatively
 * via `RefreshManager.refresh(sid)` when a downstream call needs a live token.
 * This type records the intended policy (and lets an adapter wire the
 * `"enforce-expiry"` fallback into the WS server's `enforceTokenExpiry`); a
 * reader should not expect `refresh.strategy` alone to alter the handlers.
 */
export type RefreshPolicy =
  | { strategy: "lazy" } // default: refresh on demand (Decision #16)
  | { strategy: "enforce-expiry" }; // opt-in fallback only (§F.3)

/**
 * The full cookie-BFF core config (§D.7). `TUser` is the consumer's ENRICHED
 * user (returned by `resolveUser`, attached by the verifier, echoed by
 * `/auth/me`).
 */
export interface CookieBffOptions<TUser> {
  keycloak: KeycloakOptions;

  endpoints?: EndpointOptions;

  cookies?: CookieOptions;

  /** Exact Origins allowed on the WS upgrade (Decision #10). */
  originAllowlist: string[];

  /** 32-byte AES-256-GCM key (raw bytes or base64) for at-rest tokens (§E.3). */
  encryptionKey: CipherKeyInput;

  /**
   * Retired encryption keys for the rotation grace window, by id (§E.3). New
   * sessions always use `encryptionKey`; these only decrypt older sessions.
   */
  previousEncryptionKeys?: Record<string, CipherKeyInput>;

  /** Stable id for the primary `encryptionKey`, embedded in new ciphertext. */
  encryptionKeyId?: string;

  /** Session window TTL, seconds; default 30d, slid on activity (Decision #11/#12). */
  sessionTtlSeconds?: number;

  /**
   * Re-stamp `sessionExpiresAt = now + sessionTtlSeconds` on each authed touch
   * (WS upgrade + `/auth/me`) so the 30-day window ROLLS rather than being
   * fixed from login (§E.1/§L). Default `true`. The slide is best-effort — a
   * store-write failure is logged and the upgrade / `/me` still succeeds.
   */
  slideSessionOnActivity?: boolean;

  /** The session-store seam (Decision #20). */
  sessionStore: SessionStore<TUser>;

  /**
   * The pending-login (state → PKCE verifier) seam. Defaults to an in-memory
   * store (single-instance only); multi-instance deployments MUST supply a
   * shared-store adapter.
   */
  pkceStore?: PkceStore;

  /** Refresh policy; default `{ strategy: "lazy" }`. */
  refresh?: RefreshPolicy;

  /**
   * findOrCreateUser hook — runs at /callback with the verified id-token
   * claims + the token set, returns the ENRICHED app user (Decision #22).
   *
   * `rawClaims` is the FULL decoded id_token payload (every claim the IdP
   * sent), so a consumer can read ANY claim — including ones not in the typed
   * `IdTokenClaims` whitelist — without waiting for a library release. It is
   * READ-ONLY INPUT the trusted consumer explicitly picks from; the library
   * still stores ONLY what `resolveUser` RETURNS (we never auto-spread
   * untrusted IdP JSON into the stored user). The arg is appended positionally
   * so existing `(claims, tokens) => …` callers keep compiling.
   */
  resolveUser: (
    claims: IdTokenClaims,
    tokens: OidcTokenSet,
    rawClaims: Record<string, unknown>,
  ) => Promise<TUser>;

  /** Fire-and-forget auth-flow metrics hooks (§D.7, F1b). Best-effort. */
  authEvents?: AuthEvents<TUser>;

  /**
   * SPA origin to 302 back to after a successful /callback (and the default
   * post-logout redirect). Required — the callback must know where to send
   * the browser once the cookie is set.
   */
  spaRedirectUri: string;

  /**
   * Injected HTTP seam for discovery + token calls. Defaults to the global
   * `fetch`. Injected so a consumer can add a timeout/proxy and tests can fake it.
   */
  fetcher?: Fetcher;

  clock?: Clock;
  logger?: Logger;
}

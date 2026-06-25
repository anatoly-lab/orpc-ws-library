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
   */
  resolveUser: (
    claims: IdTokenClaims,
    tokens: OidcTokenSet,
  ) => Promise<TUser>;

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

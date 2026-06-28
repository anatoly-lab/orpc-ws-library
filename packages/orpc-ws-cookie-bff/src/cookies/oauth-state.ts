// Browser-binding layer for the OAuth `state` token (login-CSRF defense, §J,
// Decision #8).
//
// The server-side `state -> code_verifier` map (Phase 1b) rejects a callback
// whose `state` has no pending entry, but that alone does NOT bind the flow to
// the browser that started it: any browser presenting a valid `(state, code)`
// pair could complete the login (login CSRF / forced login). The RFC 9700 §4.7
// fix is to ALSO store `state` in the user agent and require the callback to
// echo it — here via a short-lived httpOnly cookie set at /auth/login and
// checked at /auth/callback. This is ADDITIVE to the server-side check —
// defense in depth.
//
// SameSite: Lax by default (Decision #8, revised). This cookie has to survive a
// TOP-LEVEL GET redirect from the IdP back to `/auth/callback`, and ANY
// cross-site hop in the login redirect chain makes that callback
// cross-site-initiated — at which point a `Strict` cookie is WITHHELD on the
// navigation and `oauthStateMatches` rejects with "browser binding failed"
// (HTTP 400). Such a hop arises not only if Keycloak sits on a DIFFERENT
// registrable domain, but also when Keycloak brokers an EXTERNAL/social IdP
// (Google, GitHub, …): the final redirect back to the callback is then
// initiated from that off-site IdP. `Lax` is the correct standard default for
// an OAuth state/callback cookie — it is sent on top-level GET navigations yet
// still blocked on cross-site UNSAFE-method requests, so the login-CSRF /
// browser-binding protection is fully preserved. `sameSite` stays overridable
// (e.g. back to "strict" for a verified strictly-same-registrable-site
// topology) so the retune is config, not a code change.

import {
  clearCookie,
  parseCookie,
  serializeCookie,
  type SerializeCookieOptions,
} from "./serialize.js";
import { constantTimeEquals } from "../crypto/compare.js";

/** Default cookie name carrying the per-login `state` echo. */
export const OAUTH_STATE_COOKIE = "oauth_state";

/**
 * Default Max-Age for the state cookie, seconds. Short — it only has to
 * survive the round-trip to the IdP and back (~10 min). Note: the live
 * server-side `state` TTL (Phase 1b) may be shorter; the binding is capped by
 * the SHORTER of the two — whichever expires first invalidates the callback.
 */
export const DEFAULT_OAUTH_STATE_MAX_AGE_S = 600;

/** Attributes the state cookie shares for set + clear (must match to clear). */
export interface OAuthStateCookieOptions {
  /** Cookie name. Defaults to `"oauth_state"`. */
  cookieName?: string;
  /** Max-Age in seconds. Defaults to 600 (10 min). */
  maxAge?: number;
  /**
   * Defaults to "lax" (Decision #8, revised) — sent on the top-level GET
   * callback redirect even when the login chain has a cross-site hop, while
   * still blocking cross-site unsafe-method requests. Override to "strict" only
   * for a verified strictly-same-registrable-site topology.
   */
  sameSite?: "lax" | "strict";
  /** Defaults to true. Off only for localhost-http demos. */
  secure?: boolean;
}

function baseAttrs(opts: OAuthStateCookieOptions): SerializeCookieOptions {
  return {
    httpOnly: true,
    // Default LAX (Decision #8, revised) — see the file header. The composition
    // root resolves this once and passes it down explicitly, but the function's
    // own default must agree so a direct caller ships the same safe value.
    sameSite: opts.sameSite ?? "lax",
    secure: opts.secure ?? true,
    path: "/",
  };
}

/** `Set-Cookie` value that stashes the login's `state` in the browser. */
export function serializeOAuthStateCookie(
  state: string,
  opts: OAuthStateCookieOptions = {},
): string {
  return serializeCookie(opts.cookieName ?? OAUTH_STATE_COOKIE, state, {
    ...baseAttrs(opts),
    maxAge: opts.maxAge ?? DEFAULT_OAUTH_STATE_MAX_AGE_S,
  });
}

/** `Set-Cookie` value that clears the state cookie (single-use consumption). */
export function clearOAuthStateCookie(
  opts: OAuthStateCookieOptions = {},
): string {
  return clearCookie(opts.cookieName ?? OAUTH_STATE_COOKIE, baseAttrs(opts));
}

/**
 * Does the `oauth_state` cookie on this request match the callback's `state`?
 * False when the cookie is absent, `queryState` is absent/empty, or they
 * differ. Compared in CONSTANT time (`constantTimeEquals` → `timingSafeEqual`)
 * so the check doesn't leak the state byte-by-byte via timing. A length
 * mismatch short-circuits to `false` (already a non-match, and avoids
 * `timingSafeEqual`'s throw on unequal lengths).
 */
export function oauthStateMatches(
  cookieHeader: string | undefined,
  queryState: string,
  opts: OAuthStateCookieOptions = {},
): boolean {
  const cookieState = parseCookie(
    cookieHeader,
    opts.cookieName ?? OAUTH_STATE_COOKIE,
  );
  if (!cookieState || !queryState) return false;
  return constantTimeEquals(cookieState, queryState);
}

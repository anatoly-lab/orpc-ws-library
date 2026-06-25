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
// SameSite: Strict by default (Decision #8) — viable because the IdP is a
// subdomain of the same registrable site, so the IdP→/callback redirect is
// same-site and the cookie is sent. DEPLOYMENT DEPENDENCY: if Keycloak ever
// moved to a DIFFERENT registrable domain, the callback would become a
// cross-site top-level GET and this cookie would have to drop to `lax`
// (Strict is withheld on cross-site navigations) — expose `sameSite` so that
// retune is config, not a code change.

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
  /** Defaults to "strict" (Decision #8). Drop to "lax" only if the IdP moves off-site. */
  sameSite?: "lax" | "strict";
  /** Defaults to true. Off only for localhost-http demos. */
  secure?: boolean;
}

function baseAttrs(opts: OAuthStateCookieOptions): SerializeCookieOptions {
  return {
    httpOnly: true,
    sameSite: opts.sameSite ?? "strict",
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

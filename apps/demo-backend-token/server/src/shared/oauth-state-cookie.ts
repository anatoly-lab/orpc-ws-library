// Browser-binding layer for the OAuth `state` CSRF token (login-CSRF fix).
//
// `OidcCodeExchange` already stores a server-side `state -> code_verifier`
// map and rejects a callback whose `state` has no pending entry. That alone
// does NOT bind the flow to the browser that started it: ANY browser that
// presents a valid `(state, code)` pair completes the login (login CSRF /
// forced login). The classic fix (OAuth 2.0 Security BCP, RFC 9700 §4.7) is
// to also store the `state` in the user agent and require the callback to
// echo it back — here via a short-lived httpOnly cookie set at /auth/login
// and checked at /auth/callback. A forged callback from a different browser
// carries no (or a mismatched) cookie and is rejected before token exchange.
//
// This is ADDITIVE to the server-side `state -> verifier` check, not a
// replacement — defense in depth.

import { timingSafeEqual } from "node:crypto";

import { clearCookie, parseCookie, serializeCookie } from "./cookies.js";

/** Cookie name carrying the per-login `state` echo for browser binding. */
export const OAUTH_STATE_COOKIE = "oauth_state";

// Short TTL: the cookie only has to survive the round-trip to the IdP and
// back. 10 minutes matches the pending-state TTL in oidc-code-exchange.ts.
const STATE_COOKIE_MAX_AGE_S = 600;

/**
 * `Set-Cookie` value that stashes the login's `state` in the browser.
 *
 * SameSite=Lax is REQUIRED here (NOT Strict): the callback arrives as a
 * cross-site, top-level GET navigation — the browser follows the IdP's 302
 * back to /auth/callback from the IdP's own origin. Strict cookies are
 * withheld on cross-site navigations, so a Strict cookie would simply not be
 * sent on the callback and EVERY legitimate login would fail. Lax is sent on
 * top-level GET navigations, which is exactly this case, while still blocking
 * the cookie on cross-site sub-requests (the CSRF surface we care about).
 */
export function stateCookieHeader(state: string): string {
  return serializeCookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: STATE_COOKIE_MAX_AGE_S,
  });
}

/** `Set-Cookie` value that clears the state cookie (single-use consumption). */
export function clearStateCookieHeader(): string {
  return clearCookie(OAUTH_STATE_COOKIE);
}

/**
 * Does the `oauth_state` cookie on this request match the callback's
 * query-string `state`? False when the cookie is absent, the query `state`
 * is absent, or the two differ.
 *
 * Compared in constant time (`timingSafeEqual`) so the check doesn't leak the
 * state byte-by-byte via timing. `timingSafeEqual` throws on differing byte
 * lengths, so a length guard runs FIRST — a length mismatch is already a
 * non-match, returned without calling into the constant-time compare.
 */
export function stateCookieMatches(
  cookieHeader: string | undefined,
  queryState: string,
): boolean {
  const cookieState = parseCookie(cookieHeader, OAUTH_STATE_COOKIE);
  if (!cookieState || !queryState) return false;

  const a = Buffer.from(cookieState);
  const b = Buffer.from(queryState);
  // Length mismatch -> not equal. Must short-circuit BEFORE timingSafeEqual,
  // which throws (rather than returning false) when the buffers differ in
  // length. This branch is cheap and reveals only the length, not contents.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

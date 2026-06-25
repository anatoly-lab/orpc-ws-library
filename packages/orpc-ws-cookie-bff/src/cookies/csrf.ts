// CSRF — synchronizer-token pattern (§J, Decision #9).
//
// WHY synchronizer-token, not double-submit cookie: in the cross-subdomain
// topology (web/api/auth all under one registrable site) a readable
// double-submit cookie is the wrong tool. A non-`__Host-` CSRF cookie either
// (a) stays host-only and isn't readable by the SPA origin's JS when the SPA
// and API are different subdomains, or (b) is `Domain`-scoped to the parent
// site — which makes it readable by EVERY sibling subdomain, so a compromised
// sibling (e.g. a sandboxed-JS subdomain) could read it and forge the header.
// Either way the cookie undermines subdomain isolation.
//
// The synchronizer token avoids the cookie entirely: it's minted server-side
// at /callback, STORED IN THE SESSION, returned in the /auth/me response BODY
// (not a Set-Cookie), and the SPA holds it ONLY in JS memory — per-origin
// isolated, so a sibling subdomain's JS can't reach it. On a mutating request
// the SPA echoes it in `X-CSRF-Token`; the server validates the header against
// the SESSION-STORED token in constant time. No CSRF cookie is emitted
// anywhere.
//
// This module owns the two pure primitives: minting the token and the
// constant-time header-vs-stored compare. The session lookup + storage live in
// the handlers (callback mints + stores; me returns; logout validates).

import { randomBytes } from "node:crypto";

import { constantTimeEquals } from "../crypto/compare.js";

/** Header the SPA echoes the session's CSRF token back in. */
export const CSRF_HEADER = "x-csrf-token";
/** Token entropy: 32 bytes = 256 bits, base64url-encoded. */
const CSRF_TOKEN_BYTES = 32;

/** Mint a fresh random CSRF token (base64url, 256-bit). Minted at /callback. */
export function mintCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString("base64url");
}

/**
 * Validate a mutating request's CSRF echo against the session-stored token.
 * Both must be present and equal (constant-time). `echoed` is the
 * `X-CSRF-Token` header the adapter read off the request; `sessionToken` is
 * the value persisted in the looked-up session. Missing either side, or a
 * mismatch, → `false`.
 */
export function csrfTokenValid(
  echoed: string | undefined,
  sessionToken: string | undefined,
): boolean {
  if (!echoed || !sessionToken) return false;
  return constantTimeEquals(echoed, sessionToken);
}

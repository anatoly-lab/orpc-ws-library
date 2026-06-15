// cookie-bff WS verify: the SPA holds NO token — only an httpOnly session
// cookie. The verify reads the cookie off the upgrade request, looks up the
// server-held session, and authenticates from it. There is no `?token=`;
// `ctx.token` is unused.
//
// This is the BFF pattern at its purest: the browser is never trusted with
// a token, so an XSS can't exfiltrate one. The cost is server-held session
// state (see session-store.ts's demo-only caveat).

import type { VerifyClient } from "@orpc-ws/server-nestjs";
import type { OidcUser } from "@orpc-ws/oidc-verifier-jose";

import { parseCookie } from "../../shared/cookies.js";
import type { SessionStore } from "../../shared/session-store.js";

/**
 * Build a cookie-reading `VerifyClient`. Returns the library's standard
 * `OidcUser` shape on success so the router's `context.user` is identical
 * across all three modes (the `getUser`/`echo` handlers don't care how the
 * user was authenticated).
 *
 * Success shape: `{ ok: true, user: { sub, email?, name? },
 *   connectionKey: sub, expiresAt }`.
 * Failure shape: `{ ok: false, code: 401, reason }`.
 */
export function createCookieVerifyClient(
  store: SessionStore,
  cookieName: string,
): VerifyClient<OidcUser> {
  return async (ctx) => {
    const sid = parseCookie(ctx.req.headers.cookie, cookieName);
    if (!sid) {
      return { ok: false, code: 401, reason: "No session cookie" };
    }

    const session = store.get(sid);
    if (!session) {
      return { ok: false, code: 401, reason: "Unknown session" };
    }

    // Reject an expired access token. The session's `expiresAt` tracks the
    // server-held access token; a cookie-bff SPA can't refresh it itself
    // (it never sees the token), so an expired session means re-login.
    if (session.expiresAt <= Date.now()) {
      return { ok: false, code: 401, reason: "Session expired" };
    }

    const user: OidcUser = { sub: session.sub };
    if (session.email) user.email = session.email;
    if (session.name) user.name = session.name;

    return {
      ok: true,
      user,
      // `connectionKey` drives the registry's one-connection-per-user +
      // 4005-on-replace. Use the subject claim, same as the OIDC verifier.
      connectionKey: session.sub,
      // Bound the WS connection lifetime to the access-token expiry, so the
      // server can enforce it via `enforceTokenExpiry` if enabled.
      expiresAt: session.expiresAt,
    };
  };
}

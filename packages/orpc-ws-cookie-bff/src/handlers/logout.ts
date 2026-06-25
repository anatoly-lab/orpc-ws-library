// POST /auth/logout — CSRF-checked session teardown + RP-initiated logout.
//
// Cookie-auth makes every authed mutating POST CSRF-eligible, so logout
// requires a valid CSRF token (synchronizer-token, §J / Decision #9) BEFORE it
// mutates anything: the echoed `X-CSRF-Token` header must equal the token
// STORED IN THE SESSION (constant-time compare), NOT a cookie. So we look the
// session up via the sid cookie first, then validate header-vs-session. On
// success: delete the session, clear the sid cookie (idempotent), and return a
// best-effort RP-initiated end-session URL (with `id_token_hint`).

import { clearCookie, parseCookie } from "../cookies/serialize.js";
import { csrfTokenValid, CSRF_HEADER } from "../cookies/csrf.js";
import { getHeader } from "./headers.js";
import { fireAuthEvent } from "./fire-auth-event.js";
import type { AuthInstruction, AuthRequest } from "./instruction.js";
import type { HandlerContext } from "./context.js";

export async function handleLogout<TUser>(
  ctx: HandlerContext<TUser>,
  req: AuthRequest,
): Promise<AuthInstruction> {
  // Look up the session (the source of truth for the CSRF token) before any
  // mutation. Header lookup is case-insensitive (don't assume the adapter
  // lower-cased its keys).
  const sid = parseCookie(req.cookieHeader, ctx.cookies.sessionCookieName);
  const session = sid ? await ctx.store.get(sid).catch(() => null) : null;

  // CSRF: the echoed header must match the SESSION-STORED token (constant-time).
  // No session ⇒ no stored token ⇒ rejected (also covers a missing/forged sid).
  const echoed = getHeader(req.headers, CSRF_HEADER);
  if (!csrfTokenValid(echoed, session?.csrfToken)) {
    return { status: 403, body: { error: "CSRF validation failed" } };
  }

  // Read the id_token_hint (for RP-initiated logout) before deleting.
  let idTokenHint: string | null = null;
  if (sid) {
    if (session?.enc.idToken) {
      try {
        idTokenHint = ctx.cipher.decrypt(session.enc.idToken);
      } catch {
        idTokenHint = null; // undecryptable — skip the hint, still log out
      }
    }
    await ctx.store.delete(sid).catch(() => {
      // best-effort — a store outage must not block clearing the cookie
    });
    // Fire AFTER deleting — the session for this sub is now gone.
    fireAuthEvent(ctx.logger, "onLogout", () =>
      ctx.authEvents.onLogout?.(session?.sub ?? null),
    );
  }

  const clearSid = clearCookie(ctx.cookies.sessionCookieName, {
    httpOnly: true,
    sameSite: ctx.cookies.sameSite,
    secure: ctx.cookies.secure,
    hostPrefix: ctx.cookies.hostPrefix,
  });

  const endSessionUrl = await buildEndSessionUrl(ctx, idTokenHint);

  return {
    status: 200,
    setClearCookies: [{ value: clearSid }],
    body: { ok: true, endSessionUrl },
  };
}

/**
 * Best-effort RP-initiated logout URL. Returns `null` when the IdP doesn't
 * advertise an `end_session_endpoint` or discovery is unreachable — logout
 * still succeeds locally.
 */
async function buildEndSessionUrl<TUser>(
  ctx: HandlerContext<TUser>,
  idTokenHint: string | null,
): Promise<string | null> {
  try {
    const endpoints = await ctx.discovery.getEndpoints(ctx.discoveryUrl);
    if (!endpoints.endSessionEndpoint) return null;
    const url = new URL(endpoints.endSessionEndpoint);
    if (idTokenHint) url.searchParams.set("id_token_hint", idTokenHint);
    url.searchParams.set("post_logout_redirect_uri", ctx.postLogoutRedirectUri);
    return url.toString();
  } catch {
    return null;
  }
}

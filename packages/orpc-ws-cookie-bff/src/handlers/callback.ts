// GET /auth/callback — finish the flow, mint the session, set __Host-sid.
//
// Steps (each a reject-before-the-next on failure):
//   1. require `code` + `state` query params;
//   2. browser-binding: the `oauth_state` cookie must match the query `state`
//      (constant-time) — clear it regardless (single-use). Defense-in-depth on
//      top of the code-exchange's own server-side state→verifier check;
//   3. exchange the code for tokens (server-side PKCE);
//   4. decode id-token claims → `resolveUser(claims, tokens)` → ENRICHED user;
//   5. encrypt the token-set, mint a sid, `store.set` (TTL = session window);
//   6. Set-Cookie __Host-sid + 302 back to the SPA. No token in the body.

import { mintSid } from "../crypto/sid.js";
import { serializeCookie } from "../cookies/serialize.js";
import { mintCsrfToken } from "../cookies/csrf.js";
import {
  clearOAuthStateCookie,
  oauthStateMatches,
} from "../cookies/oauth-state.js";
import { decodeIdTokenClaims } from "../oidc/claims.js";
import type { SessionData } from "../session-store.js";
import type { AuthInstruction, AuthRequest } from "./instruction.js";
import type { HandlerContext } from "./context.js";

export async function handleCallback<TUser>(
  ctx: HandlerContext<TUser>,
  req: AuthRequest,
): Promise<AuthInstruction> {
  const code = req.query?.code;
  const state = req.query?.state;
  const clearState = clearOAuthStateCookie({
    sameSite: ctx.stateCookie.sameSite,
    secure: ctx.stateCookie.secure,
  });

  if (!code || !state) {
    return {
      status: 400,
      setClearCookies: [{ value: clearState }],
      body: { error: "Missing code/state" },
    };
  }

  // Browser-binding (login-CSRF). Clear the cookie no matter what.
  if (!oauthStateMatches(req.cookieHeader, state)) {
    return {
      status: 400,
      setClearCookies: [{ value: clearState }],
      body: { error: "Invalid OAuth state (browser binding failed)" },
    };
  }

  const tokens = await ctx.exchange.exchangeCode(code, state);
  const claims = decodeIdTokenClaims(tokens.idToken);
  if (!claims.sub) {
    return {
      status: 400,
      setClearCookies: [{ value: clearState }],
      body: { error: "id_token missing subject" },
    };
  }

  const user = await ctx.resolveUser(claims, tokens);
  const now = ctx.clock.now();
  const session: SessionData<TUser> = {
    sub: claims.sub,
    user,
    // Synchronizer-token CSRF (§J / Decision #9): mint here and STORE in the
    // session. `/auth/me` returns it in its body; logout validates the
    // echoed header against it. NO CSRF cookie is set.
    csrfToken: mintCsrfToken(),
    enc: ctx.cipher.encryptTokenSet({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
    }),
    accessTokenExpiresAt: now + tokens.expiresIn * 1000,
    sessionExpiresAt: now + ctx.sessionTtlSeconds * 1000,
    createdAt: now,
  };
  const sid = mintSid();
  await ctx.store.set(sid, session, { ttlSeconds: ctx.sessionTtlSeconds });

  const sidCookie = serializeCookie(ctx.cookies.sessionCookieName, sid, {
    httpOnly: true,
    sameSite: ctx.cookies.sameSite,
    secure: ctx.cookies.secure,
    hostPrefix: ctx.cookies.hostPrefix,
    maxAge: ctx.cookies.cookieMaxAge,
  });

  return {
    status: 302,
    redirect: ctx.spaRedirectUri,
    setCookies: [{ value: sidCookie }],
    setClearCookies: [{ value: clearState }],
  };
}

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
import { decodeIdToken } from "../oidc/claims.js";
import { fireAuthEvent } from "./fire-auth-event.js";
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

  // Every failure path fires onCallbackFailure(reason) before returning a 400.
  const fail = (reason: string): AuthInstruction => {
    fireAuthEvent(ctx.logger, "onCallbackFailure", () =>
      ctx.authEvents.onCallbackFailure?.(reason),
    );
    return {
      status: 400,
      setClearCookies: [{ value: clearState }],
      body: { error: reason },
    };
  };

  if (!code || !state) return fail("Missing code/state");

  // Browser-binding (login-CSRF). Clear the cookie no matter what.
  if (!oauthStateMatches(req.cookieHeader, state)) {
    return fail("Invalid OAuth state (browser binding failed)");
  }

  // Exchange + resolveUser may throw (token-endpoint error, consumer hook) —
  // treat any throw as a callback failure rather than letting it escape.
  let session: SessionData<TUser>;
  let user: TUser;
  try {
    const tokens = await ctx.exchange.exchangeCode(code, state);
    const { claims, raw } = decodeIdToken(tokens.idToken);
    if (!claims.sub) return fail("id_token missing subject");

    // resolveUser gets the typed claims, the token set, AND the full raw
    // payload (F2) so it can read any claim. The library stores ONLY what it
    // returns.
    user = await ctx.resolveUser(claims, tokens, raw);
    const now = ctx.clock.now();
    session = {
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
  } catch (err) {
    return fail(err instanceof Error ? err.message : "code exchange failed");
  }

  const sid = mintSid();
  await ctx.store.set(sid, session, { ttlSeconds: ctx.sessionTtlSeconds });

  const sidCookie = serializeCookie(ctx.cookies.sessionCookieName, sid, {
    httpOnly: true,
    sameSite: ctx.cookies.sameSite,
    secure: ctx.cookies.secure,
    hostPrefix: ctx.cookies.hostPrefix,
    maxAge: ctx.cookies.cookieMaxAge,
  });

  // Happy path — the enriched user that was just stored.
  fireAuthEvent(ctx.logger, "onCallbackSuccess", () =>
    ctx.authEvents.onCallbackSuccess?.(user),
  );

  return {
    status: 302,
    redirect: ctx.spaRedirectUri,
    setCookies: [{ value: sidCookie }],
    setClearCookies: [{ value: clearState }],
  };
}

// GET /auth/login — start the server-side Authorization-Code + PKCE flow.
//
// Mints state + PKCE verifier (stored server-side via the code-exchange's
// PkceStore seam), stashes `state` in a short-lived httpOnly `oauth_state`
// cookie for the browser-binding CSRF check at /callback, and 302s to the
// IdP authorize endpoint. The auth code never touches JavaScript.

import { serializeOAuthStateCookie } from "../cookies/oauth-state.js";
import { fireAuthEvent } from "./fire-auth-event.js";
import type { AuthInstruction } from "./instruction.js";
import type { HandlerContext } from "./context.js";

export async function handleLogin<TUser>(
  ctx: HandlerContext<TUser>,
): Promise<AuthInstruction> {
  fireAuthEvent(ctx.logger, "onLoginStart", () => ctx.authEvents.onLoginStart?.());
  const { url, state } = await ctx.exchange.createAuthorizationUrl();
  const stateCookie = serializeOAuthStateCookie(state, {
    sameSite: ctx.stateCookie.sameSite,
    secure: ctx.stateCookie.secure,
  });
  return {
    status: 302,
    redirect: url,
    setCookies: [{ value: stateCookie }],
  };
}

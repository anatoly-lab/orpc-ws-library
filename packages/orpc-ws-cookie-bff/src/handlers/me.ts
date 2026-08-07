// GET /auth/me — cookie-authed identity for the SPA.
//
// Reads the sid cookie, opens the drawer, and returns the ENRICHED user (the
// SPA never sees a token; it learns who it is from here). 401 when there is no
// session, the session is unknown, or it has expired. The store is the source
// of truth — a `null`/expired session means "log in again".
//
// Two concerns on the happy path:
//   - SLIDE the session window (§E.1/§L) — `/me` is one of the two
//     library-owned authed touch points (the other is the WS verifier).
//     Best-effort: a slide-write failure is logged and `/me` STILL returns 200.
//   - Return the session's CSRF token in the BODY (synchronizer-token pattern,
//     §J / Decision #9). The SPA holds it in JS memory and echoes it in the
//     `X-CSRF-Token` header on the next mutating request (logout). NO CSRF
//     cookie is set — the token lives only in the session + the SPA's memory.

import { parseCookie } from "../cookies/serialize.js";
import { slideSessionWindow } from "../session-slide.js";
import type { AuthInstruction, AuthRequest } from "./instruction.js";
import type { HandlerContext } from "./context.js";

export async function handleMe<TUser>(
  ctx: HandlerContext<TUser>,
  req: AuthRequest,
): Promise<AuthInstruction> {
  const unauthenticated: AuthInstruction = {
    status: 401,
    body: { error: "Not authenticated" },
  };

  const sid = parseCookie(req.cookieHeader, ctx.cookies.sessionCookieName);
  if (!sid) return unauthenticated;

  // TypeScript's "evolving let" analysis infers `SessionData<TUser> | null`
  // from the assignments below, so this is fully typed under tsc (`strict` is
  // on). Biome does not model evolving-any; annotating here would only
  // duplicate the store's return type.
  // biome-ignore lint/suspicious/noImplicitAnyLet: tsc's evolving-let analysis types this; see above
  let session;
  try {
    session = await ctx.store.get(sid);
  } catch {
    // Store outage — fail closed (caller treats 401 as "retry / re-login").
    return unauthenticated;
  }
  if (!session || session.sessionExpiresAt <= ctx.clock.now()) {
    return unauthenticated;
  }

  // Slide the rolling window (best-effort — never fails the /me call). The
  // slide preserves `csrfToken` (it only re-stamps `sessionExpiresAt`).
  if (ctx.slideSessionOnActivity) {
    session = await slideSessionWindow({
      store: ctx.store,
      sid,
      session,
      sessionTtlSeconds: ctx.sessionTtlSeconds,
      clock: ctx.clock,
      logger: ctx.logger,
    });
  }

  // Return the session's CSRF token in the BODY (synchronizer-token). The SPA
  // holds it in JS memory and echoes it as `X-CSRF-Token` on mutating requests.
  return {
    status: 200,
    body: { user: session.user, csrfToken: session.csrfToken },
  };
}

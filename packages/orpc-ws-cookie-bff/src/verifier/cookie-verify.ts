// The WS-upgrade cookie verifier (§D.3) — the "door-check".
//
// The SPA holds NO token, only the httpOnly `sid` cookie that rides the
// upgrade automatically. This verifier reads the cookie, opens the drawer
// (session store), and authenticates from the server-held session. There is
// no `?token=`; `ctx.token` is unused.
//
// Order is deliberate (cheapest + most-defensive first):
//   1. Origin allowlist — cross-site WS hijacking is NOT blocked by the
//      same-origin policy (the browser sends cookies on cross-origin WS
//      upgrades), so this is the only thing standing between a malicious
//      page and a cookie-authed socket. An empty/absent Origin fails closed.
//   2. Parse the sid cookie — absent ⇒ reject.
//   3. `store.get` — a THROW (store outage) FAILS CLOSED (reject, client
//      retries; never hang — Decision #21). A `null` ⇒ unknown session.
//   4. Expiry — `sessionExpiresAt` is the SESSION window (the WS lifetime),
//      NOT the access-token exp. Uses the injected `Clock`.
//
// On success `expiresAt = sessionExpiresAt` (so the connection follows the
// session window) and `connectionKey = sub` (last-wins single-connection).
// The success path ALSO slides the session window (§E.1/§L) — the WS upgrade
// is one of the two library-owned authed touch points (see session-slide.ts).

import {
  type Clock,
  type Logger,
  noopLogger,
  systemClock,
} from "@orpc-ws/shared";
import type { VerifyClient } from "@orpc-ws/server";

import { parseCookie } from "../cookies/serialize.js";
import { slideSessionWindow } from "../session-slide.js";
import type { SessionData, SessionStore } from "../session-store.js";

/** Default 30-day session window (Decision #11/#12) — slid on each touch. */
const DEFAULT_SESSION_TTL_S = 60 * 60 * 24 * 30;

/** Options for {@link createCookieVerifyClient}. */
export interface CookieVerifyOptions {
  /** Name of the session cookie (e.g. `"__Host-sid"`). */
  cookieName: string;
  /**
   * Exact Origins allowed on the WS upgrade. An empty allowlist rejects ALL
   * browser traffic (fail-closed) — the consumer must list its SPA origins.
   */
  originAllowlist: string[];
  /**
   * HTTP status written on the pre-101 reject response line for every reject
   * path (the reject happens at the upgrade, so `ws` aborts the handshake with
   * this status — it is NOT a WS close code). Defaults to 401.
   *
   * Browsers cannot observe a pre-101 status at all — a failed upgrade surfaces
   * as an opaque error and the client just retries on its backoff — so this
   * exists for server logs and non-browser clients.
   *
   * The NAME is historical: earlier versions defaulted to the WS close code
   * 4001, which `ws` wrote verbatim as the malformed status line
   * `HTTP/1.1 4001 undefined`. Kept as-is because renaming a value no browser
   * sees isn't worth a deprecation cycle.
   */
  authFailedCloseCode?: number;
  /**
   * Re-stamp `sessionExpiresAt` on each successful upgrade (rolling window).
   * Defaults to `true` (§E.1/§L). The slide write is best-effort — a failure
   * is logged and the upgrade still succeeds.
   */
  slideSessionOnActivity?: boolean;
  /** Session window TTL, seconds — the slide target. Default 30d. */
  sessionTtlSeconds?: number;
  clock?: Clock;
  logger?: Logger;
}

const DEFAULT_REJECT_STATUS = 401;

/**
 * Build the cookie-reading `VerifyClient` (§D.3). `store` is the injected
 * session store; `opts` carries the cookie name + Origin allowlist.
 */
export function createCookieVerifyClient<TUser>(
  store: SessionStore<TUser>,
  opts: CookieVerifyOptions,
): VerifyClient<TUser> {
  const code = opts.authFailedCloseCode ?? DEFAULT_REJECT_STATUS;
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? noopLogger;
  const slide = opts.slideSessionOnActivity ?? true;
  const sessionTtlSeconds = opts.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_S;
  const allowed = new Set(opts.originAllowlist);

  return async (ctx) => {
    // 1. Origin allowlist (empty origin naturally fails — fail-closed).
    if (!ctx.origin || !allowed.has(ctx.origin)) {
      return { ok: false, code, reason: "Origin not allowed" };
    }

    // 2. Session cookie.
    const sid = parseCookie(ctx.req.headers.cookie, opts.cookieName);
    if (!sid) {
      return { ok: false, code, reason: "No session cookie" };
    }

    // 3. Open the drawer — FAIL CLOSED on a store outage.
    let session: SessionData<TUser> | null;
    try {
      session = await store.get(sid);
    } catch {
      return { ok: false, code, reason: "Session store unavailable" };
    }
    if (!session) {
      return { ok: false, code, reason: "Unknown session" };
    }

    // 4. Session window (NOT the access-token exp).
    if (session.sessionExpiresAt <= clock.now()) {
      return { ok: false, code, reason: "Session expired" };
    }

    // 5. Slide the rolling window (best-effort — never fails the upgrade).
    if (slide) {
      session = await slideSessionWindow({
        store,
        sid,
        session,
        sessionTtlSeconds,
        clock,
        logger,
      });
    }

    return {
      ok: true,
      user: session.user, // ENRICHED — DB id + role available WS-side
      connectionKey: session.sub, // last-wins single-connection-per-user
      expiresAt: session.sessionExpiresAt, // SESSION window, not token exp
    };
  };
}

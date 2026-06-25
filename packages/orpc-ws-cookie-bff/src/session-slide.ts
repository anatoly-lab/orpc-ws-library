// Slide the session window on an authed touch (§E.1/§J/§L, Decisions #6/#11).
//
// The 30-day session is a ROLLING window "slid on each authed touch / refresh",
// NOT a fixed-from-login expiry. `RefreshManager` slides on a lazy refresh, but
// refresh is "often never" invoked in this app, so without sliding here the
// window would effectively be fixed from login. The two library-owned touch
// points that DO fire regularly are the WS-upgrade verifier and `/auth/me`, so
// both re-stamp `sessionExpiresAt` here.
//
// KNOWN BOUND (acceptable): a single socket that stays continuously connected,
// never reconnects, and never lazily-refreshes has no touch point after its
// initial upgrade — so it still hard-caps at `ttl` from that last touch. The
// touch points are the reconnects / refreshes the library can observe; a
// forever-open idle socket is not one. This matches the design's framing.
//
// FAILURE POLICY: the slide write is best-effort. A store-write failure must
// NEVER fail the WS upgrade or the `/me` call — we log via the injected Logger
// (noop by default) and return the (un-slid) session. We AWAIT the write (one
// extra store write per touch is the accepted cost, §K) rather than
// fire-and-forget, so the behavior is deterministic and testable.

import type { Clock, Logger } from "@orpc-ws/shared";

import type { SessionData, SessionStore } from "./session-store.js";

/** Inputs for {@link slideSessionWindow}. */
export interface SlideSessionInput<TUser> {
  store: SessionStore<TUser>;
  sid: string;
  session: SessionData<TUser>;
  sessionTtlSeconds: number;
  clock: Clock;
  logger: Logger;
}

/**
 * Re-stamp `sessionExpiresAt` to `now + ttl` and persist (sliding the window).
 * Returns the slid `SessionData` on success, or the original on a write
 * failure (logged, never thrown). Callers use the returned data so the
 * in-memory copy reflects what was (attempted to be) persisted.
 */
export async function slideSessionWindow<TUser>(
  input: SlideSessionInput<TUser>,
): Promise<SessionData<TUser>> {
  const { store, sid, session, sessionTtlSeconds, clock, logger } = input;
  const slid: SessionData<TUser> = {
    ...session,
    sessionExpiresAt: clock.now() + sessionTtlSeconds * 1000,
  };
  try {
    await store.set(sid, slid, { ttlSeconds: sessionTtlSeconds });
    return slid;
  } catch (err) {
    logger.warn("[cookie-bff] failed to slide session window", {
      reason: err instanceof Error ? err.message : "store.set failed",
    });
    return session;
  }
}

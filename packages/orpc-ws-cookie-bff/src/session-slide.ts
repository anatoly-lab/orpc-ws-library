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
//
// CONCURRENCY (why `store.touch` is preferred): the slide can run concurrently
// with the lazy refresh (`RefreshManager.doRefresh`, its own get→modify→set)
// for the same sid. A slide implemented as a full `set` from the CALLER's
// (stale) snapshot can land after the refresh's `set` and roll back the
// freshly-rotated `enc` + `accessTokenExpiresAt` — under refresh-token
// rotation the rolled-back refresh token is dead → the next refresh fails
// terminal → premature self-logout. So:
//   - When the store provides the optional `touch` (expiry-only re-stamp,
//     express-session precedent — see session-store.ts), we use it: it cannot
//     clobber any other field by construction.
//   - Otherwise we fall back to a FRESH `store.get` immediately before the
//     merged `set`. That narrows the race window from "since the caller's
//     read" (verifier/`/me` did their `get` several awaits ago) to the
//     get→set gap here, but CANNOT eliminate it — a refresh landing inside
//     that gap is still clobbered. Stores wanting full safety implement
//     `touch`. The fallback also refuses to resurrect a session deleted
//     (revoked / logged out) since the caller's read.

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
 * Prefers the store's expiry-only `touch` (race-free against a concurrent
 * lazy refresh — see file header); falls back to a fresh `get` + merged `set`
 * when `touch` is absent. Returns the slid `SessionData` on success, or the
 * original on a write failure (logged, never thrown). Callers use the
 * returned data so the in-memory copy reflects what was (attempted to be)
 * persisted.
 *
 * HONESTY CAVEAT (touch path only): `touch` returns void and is a silent
 * no-op on a vanished sid (express-session semantics), so the returned
 * optimistically-slid copy may claim a slide that persisted nothing when the
 * session was deleted mid-flight — inherent to a void-returning `touch`. The
 * fallback tier instead observes the deletion via its `get` and bails with
 * the un-slid original.
 */
export async function slideSessionWindow<TUser>(
  input: SlideSessionInput<TUser>,
): Promise<SessionData<TUser>> {
  const { store, sid, session, sessionTtlSeconds, clock, logger } = input;
  const sessionExpiresAt = clock.now() + sessionTtlSeconds * 1000;
  try {
    if (store.touch) {
      // Expiry-only re-stamp — cannot clobber a concurrent refresh's `enc` /
      // `accessTokenExpiresAt` by construction.
      await store.touch(sid, sessionExpiresAt, {
        ttlSeconds: sessionTtlSeconds,
      });
      // `touch` is void and silently no-ops on a vanished sid, so this
      // optimistically-slid copy may claim a slide that persisted nothing if
      // the session was deleted mid-flight (see the JSDoc caveat).
      return { ...session, sessionExpiresAt };
    }

    // Fallback for touch-less stores: re-read IMMEDIATELY before the write so
    // the merge starts from the freshest record (a refresh that landed since
    // the caller's read is preserved). Narrows — does not eliminate — the
    // race; see file header.
    const fresh = await store.get(sid);
    if (!fresh) {
      // Deleted (revoked / logged out) since the caller's read — a full `set`
      // here would RESURRECT the session. Skip the slide instead.
      return session;
    }
    const slid: SessionData<TUser> = { ...fresh, sessionExpiresAt };
    await store.set(sid, slid, { ttlSeconds: sessionTtlSeconds });
    return slid;
  } catch (err) {
    logger.warn("[cookie-bff] failed to slide session window", {
      reason: err instanceof Error ? err.message : "store write failed",
    });
    return session;
  }
}

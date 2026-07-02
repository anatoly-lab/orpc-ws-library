// Best-effort revocation kick (§D.5, §G, Decision #17/#18).
//
// A kick is two LOCAL actions:
//   1. store.deleteByUser(sub) — future connects AND future lazy refreshes
//      fail (the drawer is empty for that subject);
//   2. closeUser(sub, …)       — drop the live socket on THIS instance.
//
// LOCAL-ONLY by design. Cross-instance fan-out is the CONSUMER's job: every
// instance subscribes to the app's revocation event (e.g. a `session.invalidated`
// JetStream message) and calls `revokeUser(...)` locally. The library MUST NOT
// hardcode an event bus (no NATS). The kick is explicitly best-effort — a rare
// reconnect race (a just-revoked user reconnecting at the same instant) is
// accepted (Decision #17): no connect-time double-check, no kick-wins handling.

import { type Logger, noopLogger } from "@orpc-ws/shared";

import type { SessionStore } from "./session-store.js";

/** Close-user callback shape (matches `OrpcWsServer.closeUser`). */
export type CloseUser = (
  connectionKey: string,
  code?: number,
  reason?: string,
) => void;

/** Close code used for a revocation kick — the auth-failed code (4001). */
const REVOKE_CLOSE_CODE = 4001;

/**
 * Revoke every session for `sub` and drop its live socket on THIS instance.
 * Deletes from the store FIRST (so a racing reconnect that beats the close can
 * still not re-establish), then closes. Cross-instance fan-out is the
 * consumer's responsibility (see file header).
 *
 * The kick is GUARANTEED even when the store delete rejects (`finally`): the
 * more urgent action is dropping the live authenticated pipe of a just-revoked
 * user, and a store outage must not leave that socket up. We keep the
 * delete-FIRST order (not kick-first) because it is what closes the
 * reconnect race on the happy path — kick-first would let the kicked client
 * reconnect against a still-populated store before the delete lands.
 *
 * PROPAGATION: a delete failure still rejects AFTER the kick. "Best-effort"
 * (Decision #17) describes the local kick semantics — it does NOT mean a
 * store outage is swallowed. The consumer's revocation-event handler (e.g. a
 * `session.invalidated` subscriber, via `CookieBffService.revokeUser`, which
 * awaits and propagates) needs the rejection so it can retry / redeliver —
 * otherwise the sessions silently survive until their TTL.
 *
 * The kick itself is guarded by its own try/catch INSIDE the `finally`: a
 * throw escaping a `finally` block replaces the in-flight rejection (JS
 * semantics), so an unguarded throwing `closeUser` would MASK the delete
 * failure and silently break the propagation promise above. The library's
 * own `OrpcWsServer.closeUser` never throws — this guards a consumer-supplied
 * `CloseUser`; its failure is logged via the injected `Logger` (noop by
 * default) and never propagated.
 */
export async function revokeUser<TUser>(
  store: SessionStore<TUser>,
  closeUser: CloseUser,
  sub: string,
  logger: Logger = noopLogger,
): Promise<void> {
  try {
    await store.deleteByUser(sub);
  } finally {
    try {
      closeUser(sub, REVOKE_CLOSE_CODE, "session invalidated");
    } catch (err) {
      // Never let a kick failure escape the finally — it would mask the
      // deleteByUser rejection (if any). Log and move on.
      logger.warn("[cookie-bff] revocation kick (closeUser) failed", {
        reason: err instanceof Error ? err.message : "closeUser threw",
      });
    }
  }
}

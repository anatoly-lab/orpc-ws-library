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
 */
export async function revokeUser<TUser>(
  store: SessionStore<TUser>,
  closeUser: CloseUser,
  sub: string,
): Promise<void> {
  await store.deleteByUser(sub);
  closeUser(sub, REVOKE_CLOSE_CODE, "session invalidated");
}

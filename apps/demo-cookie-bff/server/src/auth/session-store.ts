// DEMO `SessionStore<DemoUser>` adapter for `@orpc-ws/cookie-bff`.
//
// ┌───────────────────────────────────────────────────────────────────┐
// │ DEMO ONLY: in-memory Maps. Sessions are LOST on restart and NOT     │
// │ shared across replicas. A real BFF persists to a shared store       │
// │ (NATS KV / Redis / SQL) so sessions survive restarts and work       │
// │ behind multiple instances. The library is agnostic — it just needs  │
// │ a `SessionStore` impl (see cookie-bff-server-design.md §E.1).       │
// └───────────────────────────────────────────────────────────────────┘
//
// The library MINTS the sid and is the sole writer of `SessionData`; this
// store only persists by key. The one non-trivial bit is `deleteByUser(sub)`
// (the revocation primitive, §G): a plain `sid → data` map can't scan by
// subject, so we keep a COMPANION INDEX `sub → Set<sid>` (§E.1), updated on
// every set/delete, and walk it to drop every session for a subject.
//
// TTL: we lean on the library's per-write `ttlSeconds` to stamp an absolute
// `expiresAt` and lazily evict on read (an expired entry reads as `null`,
// which the verifier/`/auth/me` already treat as "no session"). No background
// timer — a demo doesn't need a sweeper, and lazy eviction keeps it
// deterministic. (A production store with native TTL — NATS KV / Redis —
// would set the TTL on write instead.)

import { type Clock, systemClock } from "@orpc-ws/shared";
import type { SessionData, SessionStore } from "@orpc-ws/cookie-bff";

import type { DemoUser } from "./demo-user.js";

export class DemoSessionStore implements SessionStore<DemoUser> {
  /** sid → session record (+ its absolute expiry, epoch ms). */
  private readonly sessions = new Map<
    string,
    { data: SessionData<DemoUser>; expiresAt: number }
  >();
  /** Companion index: sub → the set of live sids for that subject (§E.1). */
  private readonly byUser = new Map<string, Set<string>>();

  // Injected clock so expiry is deterministic (CLAUDE.md forbids raw
  // `Date.now()` in library code; this is app code, but mirroring the seam
  // keeps the demo honest and testable).
  constructor(private readonly clock: Clock = systemClock) {}

  async set(
    sid: string,
    data: SessionData<DemoUser>,
    opts: { ttlSeconds: number },
  ): Promise<void> {
    // A re-`set` of an existing sid (e.g. a slid window) may change the sub in
    // theory; drop the stale index entry first to stay consistent.
    const prior = this.sessions.get(sid);
    if (prior && prior.data.sub !== data.sub) {
      this.byUser.get(prior.data.sub)?.delete(sid);
    }
    this.sessions.set(sid, {
      data,
      expiresAt: this.clock.now() + opts.ttlSeconds * 1000,
    });
    let sids = this.byUser.get(data.sub);
    if (!sids) {
      sids = new Set();
      this.byUser.set(data.sub, sids);
    }
    sids.add(sid);
  }

  // Expiry-only re-stamp (the seam's optional `touch`, preferred by the
  // library's session-window slide — it can never clobber a concurrent lazy
  // refresh's rotated tokens). No-op on an absent OR expired sid: `touch`
  // must never resurrect a session `get` would already report as gone.
  async touch(
    sid: string,
    sessionExpiresAt: number,
    opts: { ttlSeconds: number },
  ): Promise<void> {
    const entry = this.sessions.get(sid);
    if (!entry || entry.expiresAt <= this.clock.now()) return;
    entry.data = { ...entry.data, sessionExpiresAt };
    entry.expiresAt = this.clock.now() + opts.ttlSeconds * 1000;
  }

  async get(sid: string): Promise<SessionData<DemoUser> | null> {
    const entry = this.sessions.get(sid);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock.now()) {
      // Lazy eviction — an expired session reads as absent.
      this.drop(sid, entry.data.sub);
      return null;
    }
    return entry.data;
  }

  async delete(sid: string): Promise<void> {
    const entry = this.sessions.get(sid);
    if (entry) this.drop(sid, entry.data.sub);
  }

  async deleteByUser(sub: string): Promise<void> {
    const sids = this.byUser.get(sub);
    if (!sids) return;
    for (const sid of sids) this.sessions.delete(sid);
    this.byUser.delete(sub);
  }

  /** Remove a sid from both the session map and the companion index. */
  private drop(sid: string, sub: string): void {
    this.sessions.delete(sid);
    const sids = this.byUser.get(sub);
    if (sids) {
      sids.delete(sid);
      if (sids.size === 0) this.byUser.delete(sub);
    }
  }
}

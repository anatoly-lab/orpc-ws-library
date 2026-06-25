// The pending-login (state -> PKCE verifier) seam.
//
// SEAM DECISION: the demo kept the state->verifier map at MODULE level
// (`const pending = new Map(...)`). That is wrong for the library on two
// counts: (1) multi-instance — a login that lands on instance A and a
// callback that load-balances to instance B would find no verifier and fail;
// (2) testability — a module-level singleton can't be substituted in a unit
// test. So the library makes this an INJECTABLE seam, mirroring `SessionStore`
// (Decision #20's "store is the consumer's choice" principle). A consumer with
// a shared store (NATS KV / Redis) plugs in a ~15-line adapter; a single-
// instance consumer can use the in-memory default below.
//
// The verifier is SINGLE-USE — `take` reads AND deletes atomically so a
// replayed callback finds nothing and is rejected (matches the demo's
// `pending.delete(state)` on exchange).

import { type Clock, systemClock } from "@orpc-ws/shared";

/**
 * Persists a login's PKCE `code_verifier` keyed by its `state`, with a short
 * TTL (only has to survive the round-trip to the IdP). Single-use: `take`
 * consumes the entry.
 */
export interface PkceStore {
  /** Stash the verifier for `state`. `ttlSeconds` bounds an abandoned login. */
  set(
    state: string,
    codeVerifier: string,
    opts: { ttlSeconds: number },
  ): Promise<void>;
  /**
   * Atomically read AND remove the verifier for `state`. Resolves `null` when
   * `state` is unknown or expired (single-use — a replay finds nothing).
   */
  take(state: string): Promise<string | null>;
}

interface PendingEntry {
  codeVerifier: string;
  expiresAt: number;
}

/**
 * In-memory `PkceStore` for single-instance consumers (and tests). NOT shared
 * across replicas — a multi-instance deployment must supply a shared-store
 * adapter instead. Uses the injected `Clock` for expiry (no raw `Date.now()`)
 * and sweeps lazily on each `set`/`take`, so an abandoned login can't grow the
 * map unbounded.
 */
export class InMemoryPkceStore implements PkceStore {
  private readonly pending = new Map<string, PendingEntry>();

  constructor(private readonly clock: Clock = systemClock) {}

  async set(
    state: string,
    codeVerifier: string,
    opts: { ttlSeconds: number },
  ): Promise<void> {
    const now = this.clock.now();
    this.sweep(now);
    this.pending.set(state, {
      codeVerifier,
      expiresAt: now + opts.ttlSeconds * 1000,
    });
  }

  async take(state: string): Promise<string | null> {
    const now = this.clock.now();
    const entry = this.pending.get(state);
    this.pending.delete(state); // single-use, whether or not it was valid
    if (!entry) return null;
    if (entry.expiresAt <= now) return null; // expired — treat as absent
    return entry.codeVerifier;
  }

  private sweep(now: number): void {
    for (const [state, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(state);
    }
  }
}

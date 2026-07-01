// Registry-key seams for AUTHLESS connections. TWO shapes, one per
// authless sub-mode — both exist because the registry keys every
// connection by a string and the key is what decides whether a new
// connection COLLIDES with (and, under `singleConnectionPerUser`, kicks)
// an existing one:
//
//   1. DEFAULT — single global connection (`createSingleAuthlessKey`).
//      Every authless socket maps to ONE constant key (`"authless"`), so a
//      second connection collides with the first and, with
//      `singleConnectionPerUser` ON (the authless default), kicks it with
//      `4005` — a "single-GUI remote control" model where the newest tab
//      takes over. This is the shipped default.
//
//   2. CONCURRENT opt-out — coexisting connections (`createAuthlessKeyFactory`).
//      Selected by `allowConcurrentConnections: true`. Every socket gets a
//      UNIQUE monotonic key (`authless#1`, `authless#2`, …) so connections
//      never collide and never kick each other — anonymous clients coexist
//      freely (the pre-flip behavior).
//
// Both avoid the naive `JSON.stringify(undefined)` → `"undefined"` key: the
// constant seam is deliberate rather than accidental, and the unique seam
// keeps concurrent sockets distinct.
//
// Neither uses `Math.random()`/`Date.now()` (CLAUDE.md "Zero `Date.now()`
// or `Math.random()` outside an injected seam"): the counter is fully
// deterministic, so tests can assert exact keys without a fake RNG.

/** The one fixed registry key every authless socket shares in single-connection mode. */
export const SINGLE_AUTHLESS_KEY = "authless";

/**
 * Returns a function that ALWAYS yields the same constant key
 * (`SINGLE_AUTHLESS_KEY`). Used by the DEFAULT authless mode so every
 * connection collides on one key and a new connection kicks the previous
 * (single global connection). Shaped as a factory — not a bare constant —
 * so it is drop-in interchangeable with `createAuthlessKeyFactory` at the
 * one injection site.
 */
export function createSingleAuthlessKey(): () => string {
  return () => SINGLE_AUTHLESS_KEY;
}

/**
 * Returns a function that yields a fresh, unique, monotonically-increasing
 * registry key on each call (`authless#1`, `authless#2`, …). One factory
 * per server instance, so counters don't collide across servers and each
 * server's keys are stable/predictable for tests. Used ONLY by the
 * `allowConcurrentConnections` opt-out so authless sockets coexist under
 * distinct keys instead of kicking each other.
 */
export function createAuthlessKeyFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `authless#${String(n)}`;
  };
}

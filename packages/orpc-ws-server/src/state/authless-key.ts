// Unique registry-key generator for AUTHLESS connections.
//
// WHY (the foot-gun this closes): the connection registry keys every
// connection by a string. In AUTHENTICATED mode that key is the
// consumer's `connectionKey` (or `JSON.stringify(user)`). AUTHLESS
// connections have NO user — `JSON.stringify(undefined)` is the literal
// string `"undefined"`, so EVERY authless connection would map to the
// same key and, with `singleConnectionPerUser` on, kick each other.
//
// The fix is a UNIQUE key per connection. We use a monotonic counter
// rather than `Math.random()`/`Date.now()` (CLAUDE.md "Zero `Date.now()`
// or `Math.random()` outside an injected seam"): a counter is fully
// deterministic, so the foot-gun regression test can assert exact keys
// (`authless#1`, `authless#2`) without a fake RNG.

/**
 * Returns a function that yields a fresh, unique, monotonically-increasing
 * registry key on each call (`authless#1`, `authless#2`, …). One factory
 * per server instance, so counters don't collide across servers and each
 * server's keys are stable/predictable for tests.
 */
export function createAuthlessKeyFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `authless#${String(n)}`;
  };
}

// Rng seam.
//
// Reconnect jitter is the canonical use case — without a seam, jitter tests
// are flaky or weakened to "is the value in range." With a seeded fake, we
// pin exact values and assert exact backoff sequences.

export interface Rng {
  /** Returns a value in [0, 1). Same contract as `Math.random`. */
  next(): number;
}

/**
 * Default RNG backed by `Math.random`. ONLY place in the library where the
 * raw API is touched (CLAUDE.md "Zero `Date.now()` or `Math.random()` calls
 * outside an injected clock / RNG seam").
 */
export const defaultRng: Rng = {
  next: () => Math.random(),
};

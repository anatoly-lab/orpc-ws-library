// Clock seam.
//
// Wraps `Date.now` and the global timer functions so tests can inject a
// fake. CLAUDE.md forbids raw `Date.now()` / `setTimeout(...)` inside
// library code outside of this default implementation — that's what makes
// jitter, storm-guard windows, and watchdogs deterministic under test.

export interface Clock {
  now(): number;

  setTimeout(handler: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;

  setInterval(handler: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

/**
 * Opaque handle so the seam doesn't leak `NodeJS.Timeout` vs `number`
 * (browser) — the library shouldn't care, and tests substitute their own.
 */
export type TimerHandle = { readonly __brand: "TimerHandle" };

const toHandle = (raw: ReturnType<typeof setTimeout>): TimerHandle =>
  raw as unknown as TimerHandle;

const fromHandle = (h: TimerHandle): Parameters<typeof clearTimeout>[0] =>
  h as unknown as Parameters<typeof clearTimeout>[0];

/**
 * Default clock backed by `Date.now` + globals. The ONLY place in the
 * library where these raw APIs are touched (CLAUDE.md "Zero `Date.now()`
 * or `Math.random()` calls outside an injected clock / RNG seam").
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => toHandle(setTimeout(handler, ms)),
  clearTimeout: (handle) => clearTimeout(fromHandle(handle)),
  setInterval: (handler, ms) => toHandle(setInterval(handler, ms)),
  clearInterval: (handle) => clearInterval(fromHandle(handle)),
};

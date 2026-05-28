// Sleep-detection Web Worker — main-thread-driven drift detection.
//
// Phase 1.6 lift from `apps/web/src/lib/websocket/sleep/sleep-detector.worker.ts`.
//
// Behavioral change vs source:
//   The original worker carried BOTH the timer AND the drift arithmetic
//   (`elapsed = now - lastTime`; `if drift > threshold → postMessage`).
//   Here, the worker is reduced to a dumb periodic ticker — it just
//   posts `{ ts: Date.now() }` every `intervalMs`. All drift-vs-deadline
//   decisions move to the main thread `SleepDetector`, where the
//   injected `Clock` makes them deterministic under test.
//
// Why we made the cut here, not in the worker:
//   - The worker has its own thread (so its own `Date.now()`). Putting
//     a `Clock` seam inside the worker means serializing fake-clock state
//     across `postMessage`, which is messy and slow.
//   - The drift signal we actually care about ("the device was asleep")
//     is observable on EITHER side: if the OS suspended the worker, its
//     `setInterval` won't fire on time, so the main thread will see the
//     next message arrive late. Detecting that lateness in the main
//     thread is simpler and exactly as accurate.
//   - Tests can inject a mock worker via `workerFactory` and synthesize
//     any tick cadence they want, with no real `setInterval` involved.
//
// This file ships verbatim in the package source so the worker has
// somewhere to be read from for review; the runtime path bundles the
// equivalent code from `worker-source.ts` (a string constant) and runs
// it via a Blob URL — see that file for the why on the packaging choice.
//
// IMPORTANT: keep this file's logic in sync with `WORKER_SOURCE` in
// `worker-source.ts`. The two are intentionally short (~20 LOC) so the
// duplication cost is low; if either grows, switch to a build-time
// inlining step.

/**
 * Default tick cadence (ms). Must match `worker-source.ts` and the
 * `SleepDetector` `pollIntervalMs` default so the main thread's drift
 * arithmetic and the worker's ticker agree on "what 'on time' means".
 */
const INTERVAL_MS = 5_000;

/**
 * Worker entrypoint — registered eagerly. The worker is auto-started
 * (no `{ type: "start" }` handshake) because the main thread will
 * `terminate()` it to stop. This drops the message-protocol surface
 * (no `start`/`stop` types, no enum to keep in sync) and matches the
 * Blob-URL packaging where the worker code runs immediately on load.
 */
self.setInterval(() => {
  self.postMessage({ ts: Date.now() });
}, INTERVAL_MS);

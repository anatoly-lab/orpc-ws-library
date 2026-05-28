// Worker source bundled as a string + Blob-URL factory.
//
// Phase 1.6. Decision: ship the sleep-detection worker as a string
// constant and instantiate the `Worker` from a Blob URL. Rationale
// (CLAUDE.md "Validate before claiming a pattern is 'common practice'"):
//
//   - The source app used `new Worker(new URL("./worker.ts", import.meta.url),
//     { type: "module" })`. That syntax depends on a Vite-aware bundler
//     to rewrite the URL + emit the worker chunk. Every other bundler
//     (Rollup, esbuild, Webpack, Parcel, Bun) handles it differently —
//     and a published library cannot dictate the consumer's bundler.
//   - The portable alternative the web platform exposes is
//     `URL.createObjectURL(new Blob([code], { type: "application/javascript" }))`.
//     Every browser supports it; no bundler step required. This is the
//     pattern wide-spread among framework-agnostic libraries that ship
//     small workers (e.g. `comlink`'s docs recommend it for the same
//     reason).
//   - Cost: we maintain TWO copies of the worker code — the `.ts` file
//     for review/debugging, and the string constant below for runtime.
//     The worker is ~20 LOC; the duplication is tolerable. If it grows,
//     swap in a build-time inlining step (e.g. `tsup` `--banner` or a
//     Rollup plugin) — the public surface (`defaultWorkerFactory`)
//     stays the same.
//
// IMPORTANT: when editing the runtime logic, edit BOTH
// `sleep-detector.worker.ts` (the canonical source for review) AND
// the `WORKER_SOURCE` template literal below. A divergence test could
// catch drift, but the cost of one is higher than just keeping the
// strings short.

/**
 * Inlined worker source. Mirrors `sleep-detector.worker.ts`.
 *
 * KEEP IN SYNC WITH `sleep-detector.worker.ts`. The two intentionally
 * carry the same `INTERVAL_MS` literal and identical body. If you edit
 * one, edit the other.
 */
const WORKER_SOURCE = `
// Auto-generated equivalent of sleep-detector.worker.ts.
// KEEP IN SYNC with sleep-detector.worker.ts.
var INTERVAL_MS = 5000;
self.setInterval(function () {
  self.postMessage({ ts: Date.now() });
}, INTERVAL_MS);
`;

/**
 * Default worker factory: builds a `Worker` from a Blob URL containing
 * `WORKER_SOURCE`. Bundler-agnostic — works in any browser without
 * special webpack/rollup/vite configuration.
 *
 * The `SleepDetector` constructor accepts an override (`workerFactory`)
 * so tests can inject a mock `Worker` instead of spinning up a real one
 * (happy-dom's Worker support is partial; we don't want to depend on it).
 */
export function defaultWorkerFactory(): Worker {
  const blob = new Blob([WORKER_SOURCE], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  // The worker holds a reference to the object URL until terminate(),
  // so we don't `revokeObjectURL` here — doing so would race with the
  // worker boot. The URL is released when the page unloads; for a
  // long-lived SPA the memory cost is one URL entry per detector
  // instance, which is negligible. If the library grows to recycle
  // workers, revisit.
  return new Worker(url);
}

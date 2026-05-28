# `@repo/orpc-ws-shared`

Workspace-internal helper package. **Not published.** Holds the seam
interfaces every other package in this monorepo depends on, so the
client core and server core can agree on `Logger` / `Clock` / `Rng` /
heartbeat wire types without taking a dependency on each other.

If you're a consumer of `@repo/orpc-ws-client` or `@repo/orpc-ws-server`,
you don't import from here directly — `Logger` and `HeartbeatEvent` are
re-exported from the public packages. This README exists for library
contributors.

## Why a separate package

Three of the four packages need the same `Logger` shape and the same
`HEARTBEAT_PATH` constant. Inlining them in either core would force a
client → server (or server → client) dependency just for type
definitions. A workspace-internal package keeps the dependency graph
honest: both cores depend on a non-published leaf.

## What's in it

- **`Logger`** — Pino-compatible structured-args shape (`debug` /
  `info` / `warn` / `error` with an optional `Record<string, unknown>`
  meta arg). `noopLogger` is the default the cores fall back to.
  Source: [`src/logger.ts`](./src/logger.ts).
- **`Clock` + `TimerHandle`** — `now()` plus the four `setTimeout` /
  `setInterval` / `clear*` proxies. `systemClock` is the
  `Date.now`-and-globals default. Tests inject fakes so jitter and
  storm-guard windows are deterministic. The library will not call
  `Date.now()` or `setTimeout` outside this seam. Source:
  [`src/clock.ts`](./src/clock.ts).
- **`Rng`** — `next(): number` returning `[0, 1)`. `defaultRng` wraps
  `Math.random`; seeded fakes make jitter assertions exact. Source:
  [`src/rng.ts`](./src/rng.ts).
- **`HeartbeatEvent`, `HEARTBEAT_NAMESPACE`, `HEARTBEAT_PATH`** — wire
  shape and library-reserved path for the stealth heartbeat procedure.
  Server core publishes against this path; client core subscribes
  against this path. One source of truth. Source:
  [`src/heartbeat.ts`](./src/heartbeat.ts).

## Adding a new shared type

The bar is "two cores need to agree on this and neither owns the
concept." A type that only one package consumes belongs in that
package, not here.

## See also

- Top-level [README](../../README.md)
- [Implementation plan](../../docs/implementation-plan.md) §"Shared
  types pinned in Phase 0"

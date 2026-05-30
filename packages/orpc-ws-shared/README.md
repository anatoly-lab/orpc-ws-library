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

## Logger bridges

Tiny adapter factories for plugging common logger shapes into the `Logger`
seam without writing a 4-line object literal at every call site.

Consumers don't import from this package — the bridges surface on the
public packages they already depend on:

| Bridge              | Re-exported from                                          |
| ------------------- | --------------------------------------------------------- |
| `consoleLogger`     | `@repo/orpc-ws-client`, `@repo/orpc-ws-server`, `@repo/orpc-ws-server-nestjs` |
| `fromPinoShape`     | `@repo/orpc-ws-client`, `@repo/orpc-ws-server`, `@repo/orpc-ws-server-nestjs` |
| `fromNestShape`     | `@repo/orpc-ws-server-nestjs` only (Nest is a server-side concept) |

Usage:

- **`consoleLogger(prefix?)`** — wraps the global `console`. Universal,
  zero-dep, fine for SPAs and quick scripts.
  ```ts
  import { consoleLogger, createOrpcWsClient } from "@repo/orpc-ws-client";
  createOrpcWsClient({ logger: consoleLogger("orpc-ws"), ... });
  ```
- **`fromPinoShape(pino)`** — adapts a Pino-style logger. Swaps to Pino's
  native `(obj, msg)` arg order when meta is present.
  ```ts
  import pino from "pino";
  import { fromPinoShape } from "@repo/orpc-ws-server";
  // pass to OrpcWsServer / OrpcWsModule.forRoot({ logger: ... })
  ```
- **`fromNestShape(nestLogger)`** — adapts a NestJS `Logger`. Routes `info`
  to Nest's `log` (Nest has no `info`) and merges meta into a single
  `{ msg, ...meta }` payload.
  ```ts
  import { Logger } from "@nestjs/common";
  import { fromNestShape, OrpcWsModule } from "@repo/orpc-ws-server-nestjs";
  OrpcWsModule.forRoot({ logger: fromNestShape(new Logger("OrpcWs")), ... });
  ```

Input shapes (`PinoShape`, `NestShape`) are duck-typed interfaces — this
package takes no runtime dependency on Pino or `@nestjs/common`. The
consumer brings their own logger instance.

## Adding a new shared type

The bar is "two cores need to agree on this and neither owns the
concept." A type that only one package consumes belongs in that
package, not here.

## See also

- Top-level [README](../../README.md)
- [Implementation plan](../../docs/implementation-plan.md) §"Shared
  types pinned in Phase 0"

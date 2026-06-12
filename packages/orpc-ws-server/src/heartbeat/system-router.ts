// The library-owned stealth sub-router.
//
// One procedure: `__orpc_ws_lib__.heartbeat`. AsyncIterable<HeartbeatEvent>.
// No `.input()` (or `z.void()` — both are equivalent for ORPC's purposes
// when no input is passed). No auth middleware — this procedure is
// pre-auth-state liveness; the heartbeat MUST run on every connection,
// including ones where the consumer's contract-level middleware would
// reject. CLAUDE.md "Heartbeat ownership — stealth procedure pattern".
//
// We build the procedure off ORPC's bare `os` builder (no `$context`
// narrowing) so it doesn't inherit any consumer context type. ORPC's
// router-typing accepts heterogeneous sub-routers under the spread; the
// final composed router's context is the consumer's narrower one.
//
// The returned shape is a plain-object sub-router fragment:
//   { [HEARTBEAT_NAMESPACE]: { heartbeat: <handler> } }
// The composition root spreads this into the consumer's router via
// `router-composer.ts`.

import { os } from "@orpc/server";

import {
  HEARTBEAT_NAMESPACE,
  type HeartbeatEvent,
} from "@orpc-ws/shared";

import type { HeartbeatPublisher } from "./publisher.js";

/**
 * Builds the system router fragment that serves the stealth heartbeat.
 *
 * Returned as `Record<string, unknown>` because the strict types of
 * `os.handler` would force the composition root to thread the
 * library's procedure type through `composeRouter`'s generic — and
 * that fights the consumer's `TContract` typing for no benefit. The
 * fragment is opaque from the consumer's perspective; the wire address
 * is the constants in `@orpc-ws/shared/heartbeat`.
 *
 * Why output() not specified: the `.handler(async ...)` form returns an
 * inferred output type. The handler returns `AsyncIterable<HeartbeatEvent>`,
 * which ORPC recognizes via runtime probing and frames each yield. The
 * source app used `.output(z.custom<AsyncIterable<HeartbeatEvent>>())`
 * for the same effect; either works.
 */
export function buildSystemRouter(
  publisher: HeartbeatPublisher,
): Record<string, unknown> {
  // Note: the handler receives ORPC's standard arg object. We only need
  // `signal` for clean abort propagation; `context` is the empty record
  // (no `$context` narrowing on this procedure).
  const heartbeat = os.handler(
    ({ signal }: { signal?: AbortSignal }): AsyncIterable<HeartbeatEvent> =>
      publisher.subscribe(signal),
  );

  return {
    [HEARTBEAT_NAMESPACE]: {
      heartbeat,
    },
  };
}

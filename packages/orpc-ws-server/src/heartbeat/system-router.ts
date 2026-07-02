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

import { getConnectionWs } from "../state/connection-identity.js";

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
  // Note: the handler receives ORPC's standard arg object. `signal` gives
  // clean abort propagation; `context` carries no consumer-visible keys on
  // this procedure (no `$context` narrowing) but DOES carry the
  // symbol-keyed connection identity the connection handler stamped (see
  // `state/connection-identity.ts`). The identity feeds the publisher's
  // last-wins bound: one live heartbeat subscription per connection. Over
  // the HTTP upload transport the stamp is absent → `getConnectionWs`
  // returns `undefined` → the subscription is untracked (pre-existing
  // behavior; there is no WS connection to key on).
  const heartbeat = os.handler(
    ({
      signal,
      context,
    }: {
      signal?: AbortSignal;
      context?: unknown;
    }): AsyncIterable<HeartbeatEvent> =>
      publisher.subscribe(signal, getConnectionWs(context)),
  );

  return {
    [HEARTBEAT_NAMESPACE]: {
      heartbeat,
    },
  };
}

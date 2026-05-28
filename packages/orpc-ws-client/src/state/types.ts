// Connection-state vocabulary — tagged-record shape (Phase 1.7 migration).
//
// Replaces the Phase 1.1 string-literal placeholder with the design-doc-locked
// shape (CLAUDE.md §"State vs events: separate concerns"). The discriminated
// union carries enough information for reactive UIs to render meaningful
// disconnected reasons (`code`, `willRetry`) and to identify terminal
// states (`kicked`) without round-tripping a separate `ClientEvent` channel.
//
// Helper factory functions live alongside the type so call sites read as
// `setState(connecting())` / `setState(disconnected({ willRetry: true }))`
// instead of having to spell out the discriminator at every assignment.
// Cleaner than ad-hoc object literals and lets the type checker enforce the
// shape at the call site.

/**
 * WebSocket connection states.
 *
 * Tagged-record union — every transition carries its discriminator
 * (`status`) plus any per-state data the UI needs:
 *
 * - `connecting`: handshake in progress (no extra fields).
 * - `connected`: WS open and working (no extra fields).
 * - `disconnected`: WS closed.
 *   - `code` — the close code, when known. Optional because some teardown
 *     paths (e.g. consumer-driven `dispose()`) have no close-event source.
 *   - `willRetry` — `true` if the library will attempt to reconnect, `false`
 *     for terminal teardowns (`dispose()`, terminal auth failure).
 * - `kicked`: terminal state. The library will NOT retry.
 *   - `reason` — currently `"session_replaced"` only; reserved as a union
 *     so future terminal causes can be added without widening the
 *     `disconnected` branch.
 */
export type ConnectionState =
  | { status: "connecting" }
  | { status: "connected" }
  | { status: "disconnected"; code?: number; willRetry: boolean }
  | { status: "kicked"; reason: "session_replaced" };

// ----- factory helpers -----
//
// Use these instead of inline literals so the discriminator stays attached
// to the assignment and the type checker rejects malformed states.

export function connecting(): ConnectionState {
  return { status: "connecting" };
}

export function connected(): ConnectionState {
  return { status: "connected" };
}

export function disconnected(opts: {
  code?: number;
  willRetry: boolean;
}): ConnectionState {
  if (opts.code === undefined) {
    return { status: "disconnected", willRetry: opts.willRetry };
  }
  return { status: "disconnected", code: opts.code, willRetry: opts.willRetry };
}

export function kicked(reason: "session_replaced"): ConnectionState {
  return { status: "kicked", reason };
}

/**
 * Structural equality check used by `ConnectionStateManager.setState` to
 * skip the notify when the next state is observationally identical to the
 * current one. Shallow over the discriminator + the two data fields any
 * variant carries; fast and correct for the union we have.
 *
 * Kept separate from the manager so tests of the equality semantics don't
 * have to spin up a manager.
 */
export function connectionStatesEqual(
  a: ConnectionState,
  b: ConnectionState,
): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "disconnected" && b.status === "disconnected") {
    return a.code === b.code && a.willRetry === b.willRetry;
  }
  if (a.status === "kicked" && b.status === "kicked") {
    return a.reason === b.reason;
  }
  // `connecting` / `connected` carry no extra fields.
  return true;
}

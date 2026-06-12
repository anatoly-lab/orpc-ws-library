// Test-only fake `OrpcWsClient` for the React-binding tests.
//
// These tests previously reached into the core's private
// `ConnectionStateManager` (`../../state/connection-state.js`). That class is
// NOT part of the core's public surface, and this package can only import the
// core by package name — so we replace it with a minimal fake that implements
// exactly the seam the React bindings consume: the public `state` contract
// (`getState()` + `subscribe(cb)`), plus a test-only `emit(next)` to drive
// transitions.
//
// The fake faithfully reproduces the TWO load-bearing behaviors the bindings
// (and their regression tests) depend on:
//
//   1. `subscribe(cb)` does NOT immediately invoke `cb` — the bug-07
//      StrictMode-double-mount fix relies on this. The initial value flows
//      through `useSyncExternalStore`'s getSnapshot argument instead.
//
//   2. `emit(next)` dedupes by STRUCTURAL equality: a no-op transition keeps
//      the cached `getState()` reference stable, so `useSyncExternalStore`'s
//      identity-based bail-out works and React never tears. Only a
//      structurally-different state replaces the reference and notifies
//      listeners.
//
// Structural equality is done with a small flat comparison (these
// tagged-record states are shallow); we deliberately avoid importing the
// core's private `connectionStatesEqual`.

import type { OrpcWsClient, ConnectionState } from "@orpc-ws/client";

/** Shallow structural equality for the flat `ConnectionState` records. */
function statesEqual(a: ConnectionState, b: ConnectionState): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a) as (keyof ConnectionState)[];
  const bKeys = Object.keys(b) as (keyof ConnectionState)[];
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export interface FakeClient {
  /** The public client object the hooks consume. `<never>` contract: the
   * bindings never touch `rpc`, so the contract type is irrelevant here. */
  client: OrpcWsClient<never>;
  /**
   * Drive a state transition. Dedupes structurally (mirrors the core's
   * `setState`): equal-to-current is a no-op (no notify, reference kept);
   * different replaces the reference and notifies subscribers.
   */
  emit(next: ConnectionState): void;
}

/**
 * Build a fake client seeded with `initial`. The returned `client.state`
 * is the same listener bus that `emit` notifies, so a test can register its
 * own sentinel via `client.state.subscribe(...)` to observe notifications.
 */
export function makeFakeClient(initial: ConnectionState): FakeClient {
  let state: ConnectionState = initial;
  const listeners = new Set<() => void>();

  const client = {
    // Unused by the bindings, but the shape requires them. The hooks never
    // touch `rpc`, `connect`, or `dispose`.
    rpc: {} as never,
    state: {
      getState: (): ConnectionState => state,
      // Register WITHOUT invoking — the bug-07 invariant (see file header).
      subscribe: (cb: () => void): (() => void) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    },
    connect: () => {},
    dispose: () => {},
  } as unknown as OrpcWsClient<never>;

  const emit = (next: ConnectionState): void => {
    if (statesEqual(state, next)) return; // dedupe: keep reference, no notify
    state = next;
    for (const listener of listeners) listener();
  };

  return { client, emit };
}

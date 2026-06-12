// Observable connection-state manager.
//
// Phase 1.1 lift from `apps/web/src/lib/websocket/state/connection-state.ts`.
// Two intentional differences from the source:
//   1. No module-level singleton (`export const connectionStateManager = ...`
//      is gone). The composition root in Phase 1.7 instantiates this; tests
//      construct their own. See CLAUDE.md "No god files" / "Dependency
//      inversion" and implementation-plan.md §"Phase 1 — Discipline".
//   2. The source's `console.error` in `notifyListeners` is replaced by an
//      injected `Logger` (default: noop). The library never writes to the
//      console — CLAUDE.md "Zero `console.log`".

import { type Logger, noopLogger } from "@orpc-ws/shared";

import { connectionStatesEqual, type ConnectionState } from "./types.js";

/**
 * Observable connection state manager.
 *
 * Implements the `{ getState(): T; subscribe(cb: () => void): () => void }`
 * shape from CLAUDE.md §"State contract" — the same shape consumed by
 * React's `useSyncExternalStore`, Svelte stores, Vue's `customRef`, etc.
 *
 * Bug 7 invariant: `subscribe()` MUST NOT immediately invoke the callback.
 * Initial value comes from `getState()` (the `getSnapshot` half of the
 * `useSyncExternalStore` pair); calling the listener inside `subscribe()`
 * causes React StrictMode's double-mount to double-fire and creates a
 * spurious second state read. Only future `setState()` calls notify.
 */
export class ConnectionStateManager {
  private state: ConnectionState;
  private readonly listeners = new Set<() => void>();
  private readonly logger: Logger;

  constructor(
    initialState: ConnectionState,
    options: { logger?: Logger } = {},
  ) {
    this.state = initialState;
    this.logger = options.logger ?? noopLogger;
  }

  getState(): ConnectionState {
    return this.state;
  }

  setState(state: ConnectionState): void {
    // Phase 1.7 — tagged-record states can't dedupe via `!==` (every
    // factory call returns a fresh object). Structural equality over the
    // discriminator + any per-variant payload preserves the source's
    // "skip-notify on identical state" invariant.
    if (!connectionStatesEqual(this.state, state)) {
      this.state = state;
      this.notifyListeners();
    }
  }

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    // NOTE: No immediate callback! With useSyncExternalStore, the initial
    // value comes from getState() (getSnapshot), not from a callback.
    // Only notify on FUTURE state changes. See Bug 7 in the design doc.

    return () => {
      this.listeners.delete(callback);
    };
  }

  private notifyListeners(): void {
    this.listeners.forEach((callback) => {
      try {
        callback();
      } catch (error) {
        // A misbehaving listener must not break siblings, and the library
        // must not write to the console on its own. Hand the error to the
        // injected logger and continue iterating.
        this.logger.error("connection-state listener threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}

// Bug 7 regression — StrictMode-safe subscribe.
//
// The source-app bug: under React StrictMode, components mount-unmount-mount
// during development. `useSyncExternalStore(subscribe, getSnapshot)` calls
// `subscribe` on both mounts; if `subscribe` itself fires the callback, the
// store appears to change between the two mounts and React tears the tree.
// Fix: `subscribe()` registers the listener but DOES NOT invoke it. The
// initial value is the responsibility of `getSnapshot()` (= `getState()`).
//
// These tests also pin the simpler invariants we don't want to lose: dedupe
// on identical state (structural equality after the Phase 1.7 tagged-record
// migration), multi-subscriber fanout, unsubscribe disposal, constructor
// initial state.

import { describe, expect, it, vi } from "vitest";

import {
  connected,
  connecting,
  disconnected,
  kicked,
  type ConnectionState,
} from "../types.js";
import { ConnectionStateManager } from "../connection-state.js";

describe("ConnectionStateManager — Bug 7 (StrictMode-safe subscribe)", () => {
  it("subscribe() does NOT invoke the callback immediately", () => {
    const manager = new ConnectionStateManager(
      disconnected({ willRetry: false }),
    );
    const callback = vi.fn();

    manager.subscribe(callback);

    expect(callback).not.toHaveBeenCalled();
  });

  it("subscribe() invokes the callback ONLY on future state changes", () => {
    const manager = new ConnectionStateManager(
      disconnected({ willRetry: false }),
    );
    const callback = vi.fn();
    manager.subscribe(callback);

    manager.setState(connecting());
    expect(callback).toHaveBeenCalledTimes(1);

    manager.setState(connected());
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("notifies multiple subscribers on a single state change", () => {
    const manager = new ConnectionStateManager(
      disconnected({ willRetry: false }),
    );
    const callbackA = vi.fn();
    const callbackB = vi.fn();
    const callbackC = vi.fn();

    manager.subscribe(callbackA);
    manager.subscribe(callbackB);
    manager.subscribe(callbackC);

    manager.setState(connecting());

    expect(callbackA).toHaveBeenCalledTimes(1);
    expect(callbackB).toHaveBeenCalledTimes(1);
    expect(callbackC).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe removes the listener — no further callbacks", () => {
    const manager = new ConnectionStateManager(
      disconnected({ willRetry: false }),
    );
    const callback = vi.fn();
    const unsubscribe = manager.subscribe(callback);

    manager.setState(connecting());
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();

    manager.setState(connected());
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("setState with the SAME tag-only value does NOT invoke listeners", () => {
    const manager = new ConnectionStateManager(connecting());
    const callback = vi.fn();
    manager.subscribe(callback);

    // Different object instance, observationally identical: `connecting`
    // has no per-variant payload.
    manager.setState(connecting());

    expect(callback).not.toHaveBeenCalled();
    expect(manager.getState()).toEqual({ status: "connecting" });
  });

  it(
    "setState with the SAME disconnected payload (code + willRetry) does NOT invoke listeners",
    () => {
      // Phase 1.7 dedupe check works for the disconnected variant too —
      // shallow structural equality over discriminator + code + willRetry.
      const manager = new ConnectionStateManager(
        disconnected({ code: 1006, willRetry: true }),
      );
      const callback = vi.fn();
      manager.subscribe(callback);

      manager.setState(disconnected({ code: 1006, willRetry: true }));

      expect(callback).not.toHaveBeenCalled();
    },
  );

  it(
    "setState with a DIFFERENT disconnected payload DOES invoke listeners",
    () => {
      // Same discriminator, different payload (code or willRetry) — count
      // as a real transition.
      const manager = new ConnectionStateManager(
        disconnected({ code: 1006, willRetry: true }),
      );
      const callback = vi.fn();
      manager.subscribe(callback);

      // Different code:
      manager.setState(disconnected({ code: 1008, willRetry: true }));
      expect(callback).toHaveBeenCalledTimes(1);

      // Different willRetry:
      manager.setState(disconnected({ code: 1008, willRetry: false }));
      expect(callback).toHaveBeenCalledTimes(2);
    },
  );

  it("setState with the SAME connected value does NOT invoke listeners", () => {
    const manager = new ConnectionStateManager(connected());
    const callback = vi.fn();
    manager.subscribe(callback);

    manager.setState(connected());

    expect(callback).not.toHaveBeenCalled();
  });

  it("constructor accepts an initial tagged-record state and getState() returns it", () => {
    const explicit = new ConnectionStateManager(connected());
    expect(explicit.getState()).toEqual({ status: "connected" });

    const kickedManager = new ConnectionStateManager(
      kicked("session_replaced"),
    );
    expect(kickedManager.getState()).toEqual({
      status: "kicked",
      reason: "session_replaced",
    });
  });

  it("a throwing listener does not prevent siblings from running", () => {
    // Defensive invariant we don't want to silently lose: the source code
    // try/catches around each callback. We mirror that here. The injected
    // logger absorbs the report instead of `console.error`.
    const errorSpy = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: errorSpy,
    };
    const manager = new ConnectionStateManager(
      disconnected({ willRetry: false }),
      { logger },
    );

    const throwingListener = () => {
      throw new Error("boom");
    };
    const wellBehavedListener = vi.fn();

    manager.subscribe(throwingListener);
    manager.subscribe(wellBehavedListener);

    manager.setState(connecting());

    expect(wellBehavedListener).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it(
    "getState() returns a stable reference between equal states (Phase 2 — required by React's useSyncExternalStore)",
    () => {
      // `useSyncExternalStore` reads `getSnapshot` on every render and
      // bails out by identity (`===`). If the manager returns a fresh
      // object on each `getState()` call — or replaces its internal
      // reference on a no-op `setState` — React will tear: it sees a
      // "new" snapshot each render even though nothing actually changed.
      //
      // The manager's setState skips the swap when the next state is
      // structurally equal to the current one (Bug 7 sibling invariant).
      // This pins that reference-stability is preserved across
      // back-to-back `getState()` calls and across no-op `setState`s.
      const manager = new ConnectionStateManager(
        disconnected({ code: 1006, willRetry: true }),
      );

      const a = manager.getState();
      const b = manager.getState();
      expect(a).toBe(b); // same call site, no mutation in between

      // No-op setState (structurally equal) must NOT swap the reference.
      manager.setState(disconnected({ code: 1006, willRetry: true }));
      expect(manager.getState()).toBe(a);

      // Real transition produces a NEW reference.
      manager.setState(connecting());
      const next = manager.getState();
      expect(next).not.toBe(a);

      // And the new reference is itself stable.
      expect(manager.getState()).toBe(next);
    },
  );

  it("accepts every state variant in the ConnectionState union", () => {
    // Type-level smoke: if the union evolves again, this test forces us to
    // visit every variant and confirm the manager handles it.
    const states: ConnectionState[] = [
      connecting(),
      connected(),
      disconnected({ code: 1006, willRetry: true }),
      disconnected({ willRetry: false }),
      kicked("session_replaced"),
    ];
    const manager = new ConnectionStateManager(
      disconnected({ willRetry: false }),
    );
    for (const next of states) {
      manager.setState(next);
      expect(manager.getState()).toEqual(next);
    }
  });
});

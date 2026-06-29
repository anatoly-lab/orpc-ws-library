// An ordered, identity-keyed set of event listeners with DOM `once`
// semantics. One instance backs one (channel, event-type) pair inside the
// multiplexer; keeping it a separate concept (not inlined in the mux) keeps
// each file to one responsibility.

import type { SocketEvent, SocketListener } from "./socket.js";

/**
 * Holds the listeners registered for a single (channel, event-type) pair.
 *
 * A `Map` keyed by the listener function gives us two DOM behaviors for
 * free: insertion order is preserved (so dispatch fires in registration
 * order), and a duplicate `(type, listener)` registration is deduped by
 * identity (DOM ignores a second `addEventListener` with the same handler).
 */
export class ListenerRegistry {
  private readonly listeners = new Map<SocketListener, { once: boolean }>();

  /**
   * Register a listener. A duplicate is ignored (DOM keeps the FIRST
   * registration, including its `once`), so we don't overwrite an entry.
   */
  add(listener: SocketListener, once: boolean): void {
    if (!this.listeners.has(listener)) {
      this.listeners.set(listener, { once });
    }
  }

  remove(listener: SocketListener): void {
    this.listeners.delete(listener);
  }

  clear(): void {
    this.listeners.clear();
  }

  /**
   * Invoke every registered listener in registration order.
   *
   * Iterates a SNAPSHOT so a listener that adds/removes listeners (or the
   * `once` removal below) cannot disturb the in-progress walk. A `once`
   * listener is removed BEFORE it runs, so it stays single-fire even if it
   * throws.
   *
   * Per-listener isolation (DOM `EventTarget` semantics): each invocation is
   * wrapped so ONE listener's throw never prevents the remaining listeners
   * (here, and — in the multiplexer's lifecycle fan-out — the other channel's
   * listeners) from running. A caught error is handed to `onListenerError`,
   * the injected sink (no global reach), which decides where it goes.
   */
  emit(
    event: SocketEvent,
    onListenerError: (error: unknown) => void,
  ): void {
    for (const [listener, opts] of [...this.listeners]) {
      if (opts.once) {
        this.listeners.delete(listener);
      }
      try {
        listener(event);
      } catch (error) {
        onListenerError(error);
      }
    }
  }
}

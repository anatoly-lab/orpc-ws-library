// One-connection-per-user registry.
//
// Lifted from the source gateway's `userConnections = new Map<string,
// WebSocket>()`. Encapsulates two non-trivial behaviors that the source
// repeated inline at every call site:
//
//   1. Session-replacement: a second authenticated connection for the
//      same key closes the previous one with code 4005. Source had this
//      as a free-standing `if (existingWs.readyState === OPEN)` check;
//      lifting it here makes it impossible to forget at a new call site.
//
//   2. Atomic delete-if-same (Bug 9 server side): when the OLD WS's
//      `'close'` handler fires AFTER a session-replacement, naively
//      calling `userConnections.delete(key)` would remove the NEW
//      connection's entry. We compare the stored entry's WS identity to
//      the closing WS and only delete on identity match.
//
// `closeAll()` is the dispose / shutdown helper. Iterates the map and
// closes every connection with the configured shutdown code (default
// 4009). Used by `OrpcWsServer.dispose()` for graceful goodbye-before-
// TCP-RST.
//
// We type the stored user as `unknown` because the registry doesn't need
// to know the consumer's `TUser` shape — it just forwards it to the
// `onKicked` hook. Callers that DO care about TUser keep their own typed
// reference; this seam stays generic-free for simpler signatures
// downstream.

import type { WebSocket } from "ws";

import { type Logger, noopLogger } from "@repo/orpc-ws-shared";

import type { ConnectionConfig } from "../config/connection-config.js";

interface Entry {
  ws: WebSocket;
  user: unknown;
}

export interface ConnectionRegistryDeps {
  config: ConnectionConfig;
  logger?: Logger;
  /**
   * Fires when a previous connection is closed because a newer one took
   * over for the same key. Both the kicked user and the replacing WS are
   * passed so the consumer can emit a metric / log without having to
   * thread state through their own state.
   *
   * NOT a teardown hook — the registry has already issued the close by
   * the time this fires. The consumer cannot veto the kick.
   */
  onKicked?: (user: unknown, replacedBy: WebSocket) => void;
}

export class ConnectionRegistry {
  private readonly map = new Map<string, Entry>();
  private readonly config: ConnectionConfig;
  private readonly logger: Logger;
  private readonly onKicked: ((user: unknown, replacedBy: WebSocket) => void) | undefined;

  constructor(deps: ConnectionRegistryDeps) {
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
    this.onKicked = deps.onKicked;
  }

  /**
   * Register a new connection for `key`.
   *
   * When `singleConnectionPerUser` is on AND an entry already exists for
   * `key`, the old WS is closed with `sessionReplacedCloseCode` BEFORE
   * the new entry overwrites. This ordering matters: the OLD WS's
   * `'close'` event (which the connection-handler wires up to call
   * `unregisterIfSame(key, oldWs)`) will fire asynchronously AFTER this
   * method returns. By then the map already holds the new entry, and
   * `unregisterIfSame` correctly no-ops because `stored.ws !== oldWs`.
   *
   * When the switch is off, we just overwrite the map entry without
   * closing the old WS. Consumers that allow concurrent connections own
   * the deduplication for their broadcast paths.
   */
  register(key: string, ws: WebSocket, user: unknown): void {
    if (this.config.singleConnectionPerUser) {
      const existing = this.map.get(key);
      if (existing) {
        this.logger.warn("connection-registry: kicking previous session", {
          key,
        });
        try {
          existing.ws.close(
            this.config.sessionReplacedCloseCode,
            "Connected from another tab",
          );
        } catch (err) {
          // A WS that's already in a bad state can throw here. Best
          // effort — we still want to overwrite the entry below.
          this.logger.warn("connection-registry: ws.close() during kick threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (this.onKicked) {
          try {
            this.onKicked(existing.user, ws);
          } catch (err) {
            this.logger.error("connection-registry: onKicked hook threw", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }
    this.map.set(key, { ws, user });
  }

  /**
   * Delete the entry for `key` only if the stored WS is the same object
   * as `ws`. Prevents the kicked-old-WS's late `'close'` event from
   * accidentally wiping the new connection (Bug 9 server side).
   *
   * Idempotent — calling on an absent key is a no-op.
   */
  unregisterIfSame(key: string, ws: WebSocket): void {
    const stored = this.map.get(key);
    if (stored && stored.ws === ws) {
      this.map.delete(key);
    }
  }

  /**
   * Lookup. Used by `OrpcWsServer.broadcast` / `closeUser` to target a
   * specific connection.
   */
  get(key: string): WebSocket | undefined {
    return this.map.get(key)?.ws;
  }

  /** Used by tests + metrics. */
  size(): number {
    return this.map.size;
  }

  /**
   * Iterate all entries. Public so the composition root can build a
   * broadcast loop without having to drag every WS through public API
   * methods. The yielded `ws` is the live socket — callers should not
   * mutate the registry inside the iteration (e.g. don't call
   * `unregisterIfSame` mid-loop).
   */
  *entries(): IterableIterator<{ key: string; ws: WebSocket; user: unknown }> {
    for (const [key, entry] of this.map.entries()) {
      yield { key, ws: entry.ws, user: entry.user };
    }
  }

  /**
   * Close every tracked connection with `code` / `reason`. Used by
   * `OrpcWsServer.dispose()`. Errors on individual closes are swallowed
   * — best effort goodbye, never block dispose on a misbehaving socket.
   *
   * Does NOT clear the map. The follow-up `'close'` events will
   * `unregisterIfSame` each entry naturally; clearing here would race
   * with those callbacks.
   */
  closeAll(code: number, reason: string): void {
    for (const { ws } of this.map.values()) {
      try {
        ws.close(code, reason);
      } catch (err) {
        this.logger.warn("connection-registry: ws.close() in closeAll threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

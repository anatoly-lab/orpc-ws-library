// WS-protocol-level ping/pong watchdog.
//
// This is the dual-channel partner of `HeartbeatPublisher`. The publisher
// drives the ORPC channel (client-observable timeouts, kicks reconnect).
// This class drives the wire-level channel (server-observable zombies,
// kicks terminate). Both run on the same cadence by design — `intervalMs`
// — but the loss-of-pong here is a SERVER-side problem (zombie holds
// resources) while loss-of-config-event there is a CLIENT-side problem
// (client thinks connection is broken).
//
// Bug 6 mitigation: K8s / Traefik / nginx proxies drop idle WS connections
// after their own idle timer (typically 30-60s of zero bytes). Sending
// frames every `intervalMs` keeps them alive. ws.ping() is the right
// frame: it's WS-protocol, not application data, so it doesn't muddy ORPC
// framing.
//
// Aliveness tracked via WeakMap so:
//   - GC of a WebSocket auto-cleans the entry.
//   - No `(ws as any).isAlive` monkey-patch.
//
// onZombieTerminated fires AFTER the terminate; consumers use it for
// metrics. They cannot veto the terminate.

import type { WebSocket } from "ws";

import {
  type Clock,
  type Logger,
  type TimerHandle,
  noopLogger,
  systemClock,
} from "@repo/orpc-ws-shared";

import type { HeartbeatConfig } from "../config/heartbeat-config.js";

interface Entry {
  user: unknown;
  /** Pong handler reference so unregister can detach. */
  pongHandler: () => void;
}

export interface WsPingPongDeps {
  config: HeartbeatConfig;
  clock?: Clock;
  logger?: Logger;
  /**
   * Called after a zombie is `terminate()`d. Receives the user payload
   * so consumers can attribute the termination in metrics / logs.
   */
  onZombieTerminated?: (user: unknown) => void;
}

export class WsPingPong {
  private readonly config: HeartbeatConfig;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly onZombieTerminated: ((user: unknown) => void) | undefined;
  /**
   * Aliveness flag. `true` means we've seen a `pong` since the last
   * tick. `false` means we sent a ping but haven't heard back. Toggling
   * is the tick's job; `pong` handler sets back to `true`.
   *
   * WeakMap so GC of the WebSocket auto-cleans the entry; we still
   * unregister explicitly on close for prompt cleanup.
   */
  private readonly aliveness = new WeakMap<WebSocket, boolean>();
  /**
   * Registered WSs we tick over. WeakMap can't be iterated, so we keep
   * a parallel Set. Entries are deleted on unregister + after terminate.
   */
  private readonly tracked = new Set<WebSocket>();
  private readonly entries = new WeakMap<WebSocket, Entry>();
  private timer: TimerHandle | null = null;

  constructor(deps: WsPingPongDeps) {
    this.config = deps.config;
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? noopLogger;
    this.onZombieTerminated = deps.onZombieTerminated;
  }

  /**
   * Begin tracking `ws`. Wires the `pong` event so subsequent ticks know
   * the connection is alive. Initial aliveness is `true` — the caller
   * just authenticated this WS, treating it as alive on entry is
   * correct.
   */
  register(ws: WebSocket, user: unknown): void {
    const pongHandler = (): void => {
      this.aliveness.set(ws, true);
    };
    ws.on("pong", pongHandler);
    this.entries.set(ws, { user, pongHandler });
    this.tracked.add(ws);
    this.aliveness.set(ws, true);
  }

  /**
   * Stop tracking `ws`. Detaches the pong handler (so a late frame
   * after close doesn't flip aliveness on a defunct entry). Idempotent.
   */
  unregister(ws: WebSocket): void {
    const entry = this.entries.get(ws);
    if (entry) {
      try {
        ws.off("pong", entry.pongHandler);
      } catch {
        // ws may already be in a state that throws on listener mutation;
        // we don't care, we're tearing down anyway.
      }
      this.entries.delete(ws);
    }
    this.tracked.delete(ws);
    // Aliveness entry is in a WeakMap — leaving it is fine, but we
    // delete eagerly to keep the iteration size in sync.
    this.aliveness.delete(ws);
  }

  /**
   * Start the watchdog ticker. Idempotent. When `pingPong` is disabled
   * in config, this is a no-op so callers can call it unconditionally.
   */
  start(): void {
    if (!this.config.pingPong) return;
    if (this.timer !== null) return;
    this.timer = this.clock.setInterval(() => this.tick(), this.config.intervalMs);
  }

  /**
   * Stop the watchdog. Idempotent. Existing entries remain registered;
   * a future `start()` would resume ticking over them.
   */
  stop(): void {
    if (this.timer === null) return;
    this.clock.clearInterval(this.timer);
    this.timer = null;
  }

  /** Test-only: number of tracked sockets. */
  trackedCount(): number {
    return this.tracked.size;
  }

  /**
   * Single tick. For each tracked WS:
   *   - aliveness === false → zombie → terminate, unregister, fire hook
   *   - aliveness === true → mark dead (awaiting pong) + send `ws.ping()`
   *
   * The "mark dead before ping" ordering is the standard ws watchdog
   * recipe and matches the source gateway. A pong arriving between
   * `aliveness.set(false)` and the next tick flips it back to `true` —
   * everything else is the zombie path.
   */
  private tick(): void {
    for (const ws of [...this.tracked]) {
      const alive = this.aliveness.get(ws);
      if (alive === false) {
        const entry = this.entries.get(ws);
        const user = entry?.user;
        this.logger.warn("ws-ping-pong: terminating zombie");
        try {
          ws.terminate();
        } catch (err) {
          this.logger.warn("ws-ping-pong: terminate() threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        this.unregister(ws);
        if (this.onZombieTerminated) {
          try {
            this.onZombieTerminated(user);
          } catch (err) {
            this.logger.error("ws-ping-pong: onZombieTerminated hook threw", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        continue;
      }
      this.aliveness.set(ws, false);
      try {
        ws.ping();
      } catch (err) {
        // ping() can throw on a CLOSING/CLOSED socket. We'll catch the
        // zombie on the next tick when no pong arrives.
        this.logger.warn("ws-ping-pong: ping() threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

// Bounded WebSocketServer close — the NFI-4 terminate-fallback.
//
// `OrpcWsServer.dispose()` issues a graceful `close()` to every tracked
// connection (via the registry) and then awaits `wss.close()`. `ws`'s
// `close()` callback fires only once every client has finished its close
// handshake — so a single dead / half-open client (crashed laptop,
// dropped NAT mapping) stalls shutdown until `ws`'s OWN internal fallback
// timer (~30 s, hardcoded upstream) terminates it. For a process being
// drained by an orchestrator with a tighter kill window, that's a
// shutdown hang.
//
// This helper bounds the wait: it schedules a terminate-fallback on the
// injected `Clock` and force-`terminate()`s (no close handshake, straight
// to socket destroy) whatever is still in `wss.clients` when the grace
// window elapses. Terminated sockets emit 'close' immediately, `ws`
// removes them from `clients`, and the pending `wss.close()` callback
// fires — shutdown resolves promptly.
//
// Happy path is untouched: clients that complete the handshake inside the
// window drain `wss.clients` on their own, the `close()` callback fires,
// and the fallback timer is cleared without ever running.
//
// The structural `ClosableWss` slice (instead of `ws.Server`) is the test
// seam: the regression test drives a fake wss whose sockets never emit
// 'close' — exactly the dead-client shape — against a fake clock.

import type { WebSocket } from "ws";

import {
  type Clock,
  type Logger,
  type TimerHandle,
  noopLogger,
} from "@repo/orpc-ws-shared";

/**
 * The slice of `ws.WebSocketServer` the bounded close needs: the
 * callback-style `close()` and the live client set (`ws` maintains
 * `clients` itself when `clientTracking` is on — the default — removing
 * each socket as its 'close' fires, so "still in the set" means "close
 * handshake not finished").
 */
export interface ClosableWss {
  close(cb?: (err?: Error) => void): void;
  clients: Set<WebSocket>;
}

/**
 * Close `wss`, force-terminating stragglers after `graceMs`.
 *
 * Resolves when `wss.close()` reports done — which the terminate-fallback
 * guarantees happens within roughly the grace window even if a client
 * never completes its close handshake (NFI-4). Callers are expected to
 * have already sent the graceful close frames (registry `closeAll`)
 * BEFORE invoking this, so well-behaved clients see a clean
 * `shutdownCloseCode`, never a terminate.
 */
export function closeWssWithGrace(deps: {
  wss: ClosableWss;
  clock: Clock;
  graceMs: number;
  logger?: Logger;
}): Promise<void> {
  const { wss, clock, graceMs } = deps;
  const logger = deps.logger ?? noopLogger;

  return new Promise<void>((resolve) => {
    // Schedule the fallback BEFORE calling close() — defensive against a
    // close() implementation that calls back synchronously when no
    // clients exist (the clear below would otherwise see a null handle
    // and leak a timer that fires into an empty set; harmless, but a
    // cleared timer is cleaner).
    let fallback: TimerHandle | null = clock.setTimeout(() => {
      fallback = null;
      // Everything still in `clients` failed to finish its handshake
      // inside the window — force-close. terminate() emits 'close'
      // synchronously, which lets ws drain `clients` and fire the
      // pending close() callback below.
      const stragglers = [...wss.clients];
      if (stragglers.length === 0) return;
      logger.warn("orpc-ws-server: terminating stragglers after shutdown grace", {
        count: stragglers.length,
        graceMs,
      });
      for (const ws of stragglers) {
        try {
          ws.terminate();
        } catch (err) {
          // A socket in a torn state can throw; best effort — the rest
          // of the stragglers still get terminated.
          logger.warn("orpc-ws-server: terminate() during shutdown threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }, graceMs);

    wss.close(() => {
      if (fallback !== null) {
        clock.clearTimeout(fallback);
        fallback = null;
      }
      resolve();
    });
  });
}

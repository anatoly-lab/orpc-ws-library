// API-4 token-expiry watchdog — schedules a forced close at a connection's
// token expiry instant, re-arming across Node's 32-bit setTimeout ceiling.
//
// Extracted from `connection-handler.ts` as a standalone concept (SRP): it
// owns its own correctness rationale (the 32-bit clamp) and its only
// collaborator is the injected `Clock`. The handler wires it at the
// AUTHENTICATED call site when `enforceTokenExpiry` is on and the verify
// result surfaced an `expiresAt`.

import type { WebSocket } from "ws";

import type { Clock, Logger, TimerHandle } from "@orpc-ws/shared";

/**
 * Node's timer delay is a signed 32-bit int: any `setTimeout` delay above
 * 2^31 - 1 ms (~24.8 days) is clamped to 1ms and fires almost immediately.
 * For the API-4 expiry watchdog that's catastrophic, not cosmetic — a
 * 30-day token would be "expired" right after open, the client refreshes
 * and reconnects, gets closed again inside its storm window, and ends in
 * terminal logout. So the watchdog never schedules past this ceiling: it
 * sleeps at most MAX_TIMER_DELAY_MS, re-checks the clock on wake, and
 * re-arms until the expiry instant is genuinely reached.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface TokenExpiryWatchdogDeps {
  /**
   * Injected clock for the API-4 token-expiry watchdog — `now()` is the
   * epoch-ms comparand for `expiresAt`, and `setTimeout`/`clearTimeout`
   * provide the deterministic timer seam (tests pass a fake).
   */
  clock: Clock;
  /** Close code used when the token's lifetime is reached (default 4001). */
  authFailedCloseCode: number;
  logger: Logger;
}

/**
 * Arm a watchdog that closes `ws` with `authFailedCloseCode` at `expiresAt`
 * (epoch ms, compared via `clock.now()`), re-arming across the 32-bit timer
 * ceiling (see `MAX_TIMER_DELAY_MS`). Returns a `clearExpiryTimer` canceller
 * the connection's `'close'` handler invokes so a normally-closed/replaced
 * connection never leaks a timer or sees a late close from a leftover
 * re-armed segment.
 *
 * `expiresAt` already past `clock.now()` yields a 0ms timer that closes
 * promptly — verifyClient accepted the token, so `exp` skew is the
 * verifier's call, not ours to second-guess.
 */
export function armTokenExpiryWatchdog(
  deps: TokenExpiryWatchdogDeps,
  args: { ws: WebSocket; expiresAt: number; connectionKey: string },
): () => void {
  const { clock, authFailedCloseCode, logger } = deps;
  const { ws, expiresAt, connectionKey } = args;

  // Per-connection, closure-captured. Re-armed segments reassign the SAME
  // binding, so the returned canceller clears whichever segment is
  // currently pending.
  let expiryTimer: TimerHandle | null = null;

  const armExpiryTimer = (): void => {
    const msUntilExpiry = Math.max(0, expiresAt - clock.now());
    const delay = Math.min(msUntilExpiry, MAX_TIMER_DELAY_MS);
    expiryTimer = clock.setTimeout(() => {
      expiryTimer = null;
      if (clock.now() < expiresAt) {
        // Woke early — the delay was clamped to the 32-bit ceiling, not the
        // real expiry. Re-arm for the remainder; only a wake at/past
        // `expiresAt` closes.
        armExpiryTimer();
        return;
      }
      logger.info("connection-handler: token expired, closing", {
        connectionKey,
      });
      try {
        ws.close(authFailedCloseCode, "Token expired");
      } catch (err) {
        logger.warn("connection-handler: ws.close() on token expiry threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, delay);
  };

  armExpiryTimer();

  return (): void => {
    if (expiryTimer) {
      clock.clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  };
}

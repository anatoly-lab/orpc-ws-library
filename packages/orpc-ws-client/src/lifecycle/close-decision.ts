// Close-decision tree — pure function. No I/O, no side effects.
//
// Phase 1.2 NEW file. Split out from the source's monolithic
// `event-handlers.ts` so the most fragile piece of the client (the
// close-code routing logic) is 100% unit-testable in isolation.
//
// The original decision tree (source `lifecycle/event-handlers.ts:59-148`)
// is ALSO entangled with side effects: state mutation, partysocket
// wrapper.close() calls, token-refresh I/O, console logging, and a
// MODULE-LEVEL storm guard timestamp. This file keeps ONLY the pure
// branching; the orchestration calls the function and reacts to the
// returned discriminated union.
//
// Storm guard is intentionally NOT here. The source mixed it into the
// close-decision branch ("if auth failure AND less than 30s since last
// refresh attempt → treat as terminal"), but storm-guard timing is per-
// instance state that belongs to ReconnectManager (Phase 1.3). The
// decision tree merely emits `auth-recovery` and lets the orchestration
// + ReconnectManager decide whether to actually trigger a refresh.
//
// References:
//   - source `lifecycle/event-handlers.ts:59-148` (verbatim semantics)
//   - design doc §2.3 "Close-event routing — fragility audit"
//   - shared-types `WS_CLOSE_CODES` (4001 AUTH_FAILED, 4005 SESSION_REPLACED)
//
// Bug coverage in this file:
//   - Bug 4 (pre-open 1000 masked handshake failure) — the
//     `attemptHadOpened` branch.
//   - Bug 9 (stale-WS close clobbering) — the `isStaleWs` branch.
//   - Bug 23 (pre-open connection TIMEOUT misrouted to auth-recovery) —
//     the `reason === "timeout"` exemption inside the Bug-4 branch.
//   - Bug 24 (cookie-auth pre-open-1000 force-logout) — the
//     `trigger` discriminant on the `auth-recovery` variant, consumed by
//     the composition root's no-tokenProvider branch.
//   - Bug 25 (token-mode server-down force-logout) — the same `trigger`
//     discriminant, additionally consumed by ReconnectManager's storm
//     guard: a `"pre-open-1000"` storm trip rides partysocket's backoff
//     with the current token instead of going terminal.

import type { NormalizedCloseEvent } from "./event-normalizer.js";

/**
 * WHY a close routed to `auth-recovery` — carried on the decision so the
 * composition root can honor the locked cookie-auth contract (CLAUDE.md
 * §"Auth flow contract", "Cookie-auth caveat"; Bug 24):
 *
 *   - `"auth-close"`: the server EXPLICITLY signalled an auth failure
 *     (close 1008 / 4001). With no tokenProvider this is genuinely
 *     terminal — the session/cookie is dead and the library can't mint
 *     a credential.
 *   - `"pre-open-1000"`: partysocket's SYNTHETIC code-1000 close for a
 *     pre-open failure (Bug 4). partysocket synthesizes 1000 for EVERY
 *     pre-open failure — connection refused, DNS, TLS — because the
 *     browser masks the real reason; it is only a *candidate* auth
 *     signal, worth a refresh in token mode but NEVER proof of a dead
 *     session under cookie auth.
 */
export type AuthRecoveryTrigger = "auth-close" | "pre-open-1000";

/**
 * Discriminated-union output of the close-decision tree.
 *
 * Each variant maps 1:1 to a single side-effecting branch in the
 * orchestration layer. Keeping the union exhaustive (no implicit "else")
 * forces every code change to think about every branch.
 */
export type CloseDecision =
  | { kind: "ignore"; reason: "stale-ws" }
  | { kind: "session-replaced" }
  | { kind: "auth-recovery"; closeCode: number; trigger: AuthRecoveryTrigger }
  | { kind: "normal-disconnect"; closeCode: number };

/** Inputs for the close-decision function. Pure data; no callbacks. */
export interface CloseDecisionInput {
  /** Normalized close event (numeric code guaranteed). */
  event: NormalizedCloseEvent;
  /**
   * True when the wrapper that emitted this close has already been replaced
   * in the holder (wrapper !== holder.get()). Captured by orchestration.
   */
  isStaleWs: boolean;
  /**
   * True when this attempt actually reached the "open" state. Used to
   * detect the Bug-4 shape: partysocket emits a code-1000 close BEFORE
   * the first open if the handshake failed at the browser layer (auth or
   * pre-open error). Without this flag we'd misroute that to "normal
   * disconnect" and silently loop.
   */
  attemptHadOpened: boolean;
}

/** Custom close-code 4005, session replaced by another tab. Terminal. */
const CODE_SESSION_REPLACED = 4005;
/** WS standard 1008 = Policy Violation. The server uses it for auth-related rejections. */
const CODE_POLICY_VIOLATION = 1008;
/** Custom close-code 4001 = AUTH_FAILED (see shared-types `WS_CLOSE_CODES`). */
const CODE_AUTH_FAILED = 4001;
/** WS standard 1000 = Normal Closure. partysocket also synthesizes 1000 for pre-open browser-level failures (Bug 4). */
const CODE_NORMAL = 1000;
/**
 * The exact `reason` partysocket 1.3.0 puts on the synthetic pre-open close
 * when its own `connectionTimeout` fires: `_handleTimeout()` →
 * `ErrorEvent(Error("TIMEOUT"))` → `_handleError` →
 * `_disconnect(void 0, event.message === "TIMEOUT" ? "timeout" : void 0)` →
 * `_handleClose(new CloseEvent(1000, "timeout"))` (partysocket dist/ws.js).
 * Every OTHER pre-open failure reaches `_disconnect` with `reason: void 0`,
 * so the CloseEvent constructor defaults it to `""` — the string "timeout"
 * uniquely identifies the connection-timeout shape.
 */
const PARTYSOCKET_TIMEOUT_REASON = "timeout";

/**
 * Decide what to do about a close event. Pure: same input → same output.
 *
 * Decision tree (in priority order — first match wins):
 *   1. `isStaleWs`                       → ignore.
 *   2. `code === 4005`                   → session-replaced (terminal).
 *   3. `code === 1008` or `code === 4001` → auth-recovery (`"auth-close"`).
 *   4. `code === 1000` AND `!attemptHadOpened`:
 *      a. `reason === "timeout"`         → normal-disconnect (Bug 23).
 *      b. otherwise                      → auth-recovery
 *                                          (`"pre-open-1000"`, Bug 4).
 *   5. otherwise                         → normal-disconnect.
 *
 * Notes:
 *   - Storm-guard rate-limiting lives in ReconnectManager (Phase 1.3),
 *     NOT here. We always emit `auth-recovery` when the close matches;
 *     the orchestration's `onAuthRecoveryNeeded` callback is responsible
 *     for the actual debouncing.
 *   - The pre-open 1000 branch (Bug 4) deliberately does NOT match 1006
 *     or other transient codes — those are network failures and should
 *     ride partysocket's normal backoff.
 */
export function decideClose(input: CloseDecisionInput): CloseDecision {
  if (input.isStaleWs) {
    return { kind: "ignore", reason: "stale-ws" };
  }

  const code = input.event.code;

  if (code === CODE_SESSION_REPLACED) {
    return { kind: "session-replaced" };
  }

  if (code === CODE_POLICY_VIOLATION || code === CODE_AUTH_FAILED) {
    return { kind: "auth-recovery", closeCode: code, trigger: "auth-close" };
  }

  if (code === CODE_NORMAL && !input.attemptHadOpened) {
    if (input.event.reason === PARTYSOCKET_TIMEOUT_REASON) {
      // Bug 23: partysocket synthesizes CloseEvent(1000, "timeout") when
      // its connectionTimeout fires before open. A connection timeout is a
      // network condition (slow/blackholed path), NEVER an auth signal —
      // routing it to auth-recovery burned a storm-guard-gated refresh on
      // every slow network and, when two timeouts landed inside the 30s
      // window, tripped a spurious terminal logout. Ride partysocket's
      // normal backoff instead. The event-normalizer preserves `reason`
      // verbatim on the happy (numeric-code) path, so the string survives
      // to here.
      return { kind: "normal-disconnect", closeCode: CODE_NORMAL };
    }
    // Bug 4: partysocket reports the standard "normal close" code on a
    // browser-level pre-open failure (the WebSocket spec masks the real
    // reason). Treat code-1000-before-open as an auth-recovery candidate —
    // tagged "pre-open-1000" so the composition root can distinguish this
    // *candidate* from a server-signalled auth close (Bug 24: under cookie
    // auth this shape must stay benign, not terminal).
    return {
      kind: "auth-recovery",
      closeCode: CODE_NORMAL,
      trigger: "pre-open-1000",
    };
  }

  return { kind: "normal-disconnect", closeCode: code };
}

// Close-decision pure-function tests.
//
// Every branch of the decision tree gets at least one named test. These
// are the canonical reference for "what should the orchestration do for
// close code X with conditions Y, Z?" — when changing the decision logic,
// these are the first tests to read.
//
// The tree (in priority order):
//   1. isStaleWs                       → ignore
//   2. code === 4005                   → session-replaced (terminal)
//   3. code === 1008 OR code === 4001  → auth-recovery
//   4. code === 1000 AND !opened       → auth-recovery   (Bug 4)
//   5. otherwise                       → normal-disconnect

import { describe, expect, it } from "vitest";

import {
  decideClose,
  type CloseDecision,
} from "../close-decision.js";
import type { NormalizedCloseEvent } from "../event-normalizer.js";

// Factories keep test bodies focused on the *interesting* fields. Defaults
// match the most common path: clean numeric close, no reason.
function makeCloseEvent(
  partial: Partial<NormalizedCloseEvent> = {},
): NormalizedCloseEvent {
  return {
    type: "close",
    code: partial.code ?? 1000,
    reason: partial.reason ?? "",
    wasClean: partial.wasClean ?? true,
  };
}

describe("decideClose — priority 1: stale-WS guard (Bug 9)", () => {
  it("stale wrapper → ignore, regardless of close code", () => {
    // The stale-WS guard wins over EVERY other branch, including 4005.
    // This is the root of Bug 9: a delayed close from a replaced wrapper
    // must not clobber the new wrapper's state.
    const codes = [1000, 1006, 1008, 4001, 4005];
    for (const code of codes) {
      const decision = decideClose({
        event: makeCloseEvent({ code }),
        isStaleWs: true,
        attemptHadOpened: true,
      });
      expect(decision).toEqual({
        kind: "ignore",
        reason: "stale-ws",
      } satisfies CloseDecision);
    }
  });
});

describe("decideClose — priority 2: session-replaced (4005)", () => {
  it("code 4005 → session-replaced (terminal)", () => {
    const decision = decideClose({
      event: makeCloseEvent({ code: 4005, reason: "Session replaced" }),
      isStaleWs: false,
      attemptHadOpened: true,
    });
    expect(decision).toEqual({ kind: "session-replaced" });
  });

  it("code 4005 wins over auth-recovery if both could match", () => {
    // attemptHadOpened === false would normally trigger the 1000-pre-open
    // branch, but the priority order asserts 4005 short-circuits first.
    // (4005 is never 1000, but this guards against future regressions if
    // the priority were ever reordered.)
    const decision = decideClose({
      event: makeCloseEvent({ code: 4005 }),
      isStaleWs: false,
      attemptHadOpened: false,
    });
    expect(decision.kind).toBe("session-replaced");
  });
});

describe("decideClose — priority 3: auth-recovery on signalled auth failures", () => {
  it("code 1008 (Policy Violation) → auth-recovery", () => {
    expect(
      decideClose({
        event: makeCloseEvent({ code: 1008 }),
        isStaleWs: false,
        attemptHadOpened: true,
      }),
    ).toEqual({ kind: "auth-recovery", closeCode: 1008 });
  });

  it("code 4001 (AUTH_FAILED custom) → auth-recovery", () => {
    expect(
      decideClose({
        event: makeCloseEvent({ code: 4001 }),
        isStaleWs: false,
        attemptHadOpened: true,
      }),
    ).toEqual({ kind: "auth-recovery", closeCode: 4001 });
  });

  it("auth-recovery codes match regardless of attemptHadOpened", () => {
    // A 1008 can fire either pre-open (handshake auth fail) or post-open
    // (server revokes mid-session). Both routes go through auth-recovery.
    for (const opened of [true, false]) {
      expect(
        decideClose({
          event: makeCloseEvent({ code: 1008 }),
          isStaleWs: false,
          attemptHadOpened: opened,
        }).kind,
      ).toBe("auth-recovery");
    }
  });
});

describe("decideClose — priority 4: Bug 4 (code 1000 before first open)", () => {
  it("code 1000 + !attemptHadOpened → auth-recovery", () => {
    // partysocket synthesizes code 1000 when the browser's underlying
    // WebSocket emits 'error' before 'open' (the spec masks the real
    // reason). The library treats this specific shape as a handshake/auth
    // failure to break the silent infinite-reconnect loop.
    expect(
      decideClose({
        event: makeCloseEvent({ code: 1000 }),
        isStaleWs: false,
        attemptHadOpened: false,
      }),
    ).toEqual({ kind: "auth-recovery", closeCode: 1000 });
  });

  it("code 1000 + attemptHadOpened → normal-disconnect (no Bug-4 misroute)", () => {
    // A clean post-open 1000 is just the server closing normally; it must
    // NOT be misrouted to auth-recovery (the source bug pre-Bug-4-fix).
    expect(
      decideClose({
        event: makeCloseEvent({ code: 1000 }),
        isStaleWs: false,
        attemptHadOpened: true,
      }),
    ).toEqual({ kind: "normal-disconnect", closeCode: 1000 });
  });
});

describe("decideClose — priority 5: normal-disconnect fallback", () => {
  it("code 1006 (abnormal closure, e.g. network drop) → normal-disconnect", () => {
    // 1006 is the "the connection went away without a Close frame" code.
    // It is NOT routed to auth-recovery even pre-open: we want partysocket
    // to handle it via normal backoff. See close-decision.ts comment.
    expect(
      decideClose({
        event: makeCloseEvent({ code: 1006, wasClean: false }),
        isStaleWs: false,
        attemptHadOpened: false,
      }),
    ).toEqual({ kind: "normal-disconnect", closeCode: 1006 });
  });

  it("code 4009 (server shutdown) → normal-disconnect", () => {
    expect(
      decideClose({
        event: makeCloseEvent({ code: 4009, reason: "shutdown" }),
        isStaleWs: false,
        attemptHadOpened: true,
      }),
    ).toEqual({ kind: "normal-disconnect", closeCode: 4009 });
  });

  it("any unknown numeric code → normal-disconnect", () => {
    expect(
      decideClose({
        event: makeCloseEvent({ code: 4042 }),
        isStaleWs: false,
        attemptHadOpened: true,
      }),
    ).toEqual({ kind: "normal-disconnect", closeCode: 4042 });
  });
});

// Regression — verifyClient invocation hardening (fail-closed, no crash).
//
// The orchestrator used to invoke `this.verify(...).then().catch()` with
// no guard around the INVOCATION itself, so only async rejections reached
// `.catch`. Two escape routes crashed the process (uncaughtException out
// of the HTTP server's 'upgrade' emit — `ws` v8 does not wrap its
// verifyClient call site):
//
//   1. A plain-JS consumer's non-async verify throwing SYNCHRONOUSLY
//      (e.g. `jwt.decode` on a garbage `?token=`) — attacker-triggerable.
//   2. A plain-JS consumer returning the result object directly (a
//      non-thenable) → `.then is not a function` TypeError, same escape.
//
// Pinned here: both routes are handled — sync throw fails closed with the
// SAME 500 shape as the async-rejection path; a non-thenable ok/!ok result
// is treated exactly as an already-resolved promise. Same fakes as
// verify-client-orchestrator.test.ts.

import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "http";
import { Socket } from "net";

import type { Logger } from "@orpc-ws/shared";

import {
  VerifyClientOrchestrator,
  type VerifyClient,
  type VerifyClientResult,
} from "../verify-client-orchestrator.js";

interface FakeUser {
  sub: string;
}

/** Same minimal IncomingMessage synth as verify-client-orchestrator.test.ts. */
function fakeReq(url = "/ws?token=tok-1"): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  return { url, headers: {}, socket } as unknown as IncomingMessage;
}

function fakeLogger(): Logger & { error: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("VerifyClientOrchestrator — sync-throw / non-thenable hardening", () => {
  it("sync-throwing verify: no throw escapes, rejects 500 fail-closed, logs; no stash", () => {
    // A non-async verify that throws synchronously. `() => never` is
    // assignable to the Promise-returning VerifyClient type, which is
    // exactly how a plain-TS consumer can ship this without a cast.
    const verify: VerifyClient<FakeUser> = () => {
      throw new Error("malformed token");
    };
    const logger = fakeLogger();
    const orch = new VerifyClientOrchestrator<FakeUser>(verify, logger);
    const cb = orch.buildWsVerifyClient();

    const req = fakeReq("/ws?token=garbage");
    const callback = vi.fn();

    // The load-bearing assertion: the invocation must NOT propagate the
    // throw (it would escape ws's unwrapped verifyClient call site and
    // crash the process).
    expect(() =>
      cb({ origin: "x", secure: false, req }, callback),
    ).not.toThrow();

    // Fail-closed, synchronously, with the SAME shape as the
    // async-rejection path (see the "when verify throws" test in
    // verify-client-orchestrator.test.ts).
    expect(callback).toHaveBeenCalledWith(false, 500, "Internal server error");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(orch.getAuthForRequest(req)).toBeUndefined();
  });

  it("sync-throwing verify: the orchestrator stays functional — a later good upgrade succeeds", async () => {
    // Throws SYNCHRONOUSLY (no async boundary) on the first upgrade,
    // behaves on the second — models one malformed-token request
    // followed by a legitimate client hitting the same server.
    let first = true;
    const verify: VerifyClient<FakeUser> = () => {
      if (first) {
        first = false;
        throw new Error("boom on first upgrade");
      }
      return Promise.resolve({ ok: true, user: { sub: "good" } });
    };
    const orch = new VerifyClientOrchestrator<FakeUser>(verify, fakeLogger());
    const cb = orch.buildWsVerifyClient();

    const badCallback = vi.fn();
    cb({ origin: "x", secure: false, req: fakeReq() }, badCallback);
    expect(badCallback).toHaveBeenCalledWith(
      false,
      500,
      "Internal server error",
    );

    // Second upgrade — must go through untouched.
    const goodReq = fakeReq("/ws?token=good");
    const goodCallback = vi.fn();
    cb({ origin: "x", secure: false, req: goodReq }, goodCallback);
    await new Promise((r) => setTimeout(r, 0));

    expect(goodCallback).toHaveBeenCalledWith(true);
    expect(orch.getAuthForRequest(goodReq)).toEqual({
      ok: true,
      user: { sub: "good" },
    });
  });

  it("non-thenable ok return: accepted exactly like a resolved promise (stash + callback true)", async () => {
    const user = { sub: "plain-js" };
    // Models an untyped plain-JS consumer returning the result object
    // directly instead of a promise. Illegal per the typed contract
    // (hence the cast) — the runtime hardening routes it through
    // Promise.resolve instead of exploding on `.then is not a function`.
    const verify = (() => ({
      ok: true,
      user,
      connectionKey: "ck-1",
    })) as unknown as VerifyClient<FakeUser>;
    const orch = new VerifyClientOrchestrator<FakeUser>(verify, fakeLogger());
    const cb = orch.buildWsVerifyClient();

    const req = fakeReq();
    const callback = vi.fn();

    expect(() =>
      cb({ origin: "x", secure: false, req }, callback),
    ).not.toThrow();
    // Promise.resolve defers the .then to a microtask even for a
    // non-thenable — same settle pattern as the async tests.
    await new Promise((r) => setTimeout(r, 0));

    expect(callback).toHaveBeenCalledWith(true);
    expect(orch.getAuthForRequest(req)).toEqual({
      ok: true,
      user,
      connectionKey: "ck-1",
    });
  });

  it("non-thenable !ok return: rejected with the supplied code/reason, no stash", async () => {
    const result: VerifyClientResult<FakeUser> = {
      ok: false,
      code: 4001,
      reason: "Bad token",
    };
    const verify = (() => result) as unknown as VerifyClient<FakeUser>;
    const orch = new VerifyClientOrchestrator<FakeUser>(verify, fakeLogger());
    const cb = orch.buildWsVerifyClient();

    const req = fakeReq();
    const callback = vi.fn();

    cb({ origin: "x", secure: false, req }, callback);
    await new Promise((r) => setTimeout(r, 0));

    expect(callback).toHaveBeenCalledWith(false, 4001, "Bad token");
    expect(orch.getAuthForRequest(req)).toBeUndefined();
  });
});

// Phase 3.3 — verify-client orchestrator unit tests.
//
// Four behaviors pinned:
//   1. The ws callback resolves true + stashes the auth result when the
//      consumer's verify returns ok.
//   2. The ws callback resolves false + reports code/reason when verify
//      returns !ok.
//   3. getAuthForRequest(req) returns the same result the verify stashed.
//   4. SEC-3 — `info.origin` / `info.secure` from the ws upgrade are
//      forwarded to the consumer's verify (absent origin → "").

import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "http";
import { Socket } from "net";

import {
  VerifyClientOrchestrator,
  type VerifyClient,
} from "../verify-client-orchestrator.js";

interface FakeUser {
  sub: string;
}

/**
 * Synthesize an IncomingMessage with the bits the orchestrator reads:
 * url (for `?token=`), headers (for host + x-forwarded-for), socket
 * (for remoteAddress).
 */
function fakeReq(opts: {
  url?: string;
  host?: string;
  xForwardedFor?: string;
  remoteAddress?: string;
}): IncomingMessage {
  const socket = new Socket();
  // Override remoteAddress getter
  Object.defineProperty(socket, "remoteAddress", {
    value: opts.remoteAddress ?? "127.0.0.1",
    configurable: true,
  });

  const headers: Record<string, string> = {};
  if (opts.host) headers.host = opts.host;
  if (opts.xForwardedFor) headers["x-forwarded-for"] = opts.xForwardedFor;

  // Minimal IncomingMessage shape — we don't need the EventEmitter
  // surface for these tests.
  const req = {
    url: opts.url ?? "/ws?token=tok-1",
    headers,
    socket,
  } as unknown as IncomingMessage;
  return req;
}

describe("VerifyClientOrchestrator", () => {
  it("buildWsVerifyClient: calls the consumer verify with token + clientIp", async () => {
    const verify: VerifyClient<FakeUser> = vi.fn(async () => ({
      ok: true,
      user: { sub: "abc" },
    }));
    const orch = new VerifyClientOrchestrator<FakeUser>(verify);
    const cb = orch.buildWsVerifyClient();

    const req = fakeReq({ url: "/ws?token=t1", host: "example.com" });
    const callback = vi.fn();

    cb({ origin: "x", secure: false, req }, callback);
    await new Promise((r) => setTimeout(r, 0));

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ req, token: "t1" }),
    );
    expect(callback).toHaveBeenCalledWith(true);
  });

  // SEC-3 — the consumer's verify must see the upgrade's Origin header
  // and the wss/ws flag, so an origin allowlist is implementable without
  // reaching into req.headers manually.
  it("forwards info.origin and info.secure to the consumer verify (SEC-3)", async () => {
    const verify = vi.fn(async () => ({
      ok: true as const,
      user: { sub: "x" },
    }));
    const orch = new VerifyClientOrchestrator<FakeUser>(verify);
    const cb = orch.buildWsVerifyClient();

    cb(
      { origin: "https://app.example.com", secure: true, req: fakeReq({}) },
      vi.fn(),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "https://app.example.com",
        secure: true,
      }),
    );
  });

  // SEC-3 — non-browser clients send no Origin header; ws then passes
  // `undefined` at runtime (its types lie). The orchestrator normalizes
  // to "" so a consumer allowlist check fails closed instead of throwing
  // on `undefined`.
  it("normalizes an absent Origin header to empty string (SEC-3)", async () => {
    const verify = vi.fn(async () => ({
      ok: true as const,
      user: { sub: "x" },
    }));
    const orch = new VerifyClientOrchestrator<FakeUser>(verify);
    const cb = orch.buildWsVerifyClient();

    cb({ origin: undefined, secure: false, req: fakeReq({}) }, vi.fn());
    await new Promise((r) => setTimeout(r, 0));

    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "", secure: false }),
    );
  });

  it("on ok result: stashes auth result for getAuthForRequest", async () => {
    const user = { sub: "abc" };
    const verify: VerifyClient<FakeUser> = async () => ({
      ok: true,
      user,
      connectionKey: "ck-1",
    });
    const orch = new VerifyClientOrchestrator<FakeUser>(verify);
    const cb = orch.buildWsVerifyClient();

    const req = fakeReq({});
    const callback = vi.fn();

    cb({ origin: "x", secure: false, req }, callback);
    await new Promise((r) => setTimeout(r, 0));

    expect(callback).toHaveBeenCalledWith(true);
    const stashed = orch.getAuthForRequest(req);
    expect(stashed).toEqual({ ok: true, user, connectionKey: "ck-1" });
  });

  it("on !ok result: rejects with the supplied code and reason; no stash", async () => {
    const verify: VerifyClient<FakeUser> = async () => ({
      ok: false,
      code: 4001,
      reason: "Bad token",
    });
    const orch = new VerifyClientOrchestrator<FakeUser>(verify);
    const cb = orch.buildWsVerifyClient();

    const req = fakeReq({});
    const callback = vi.fn();

    cb({ origin: "x", secure: false, req }, callback);
    await new Promise((r) => setTimeout(r, 0));

    expect(callback).toHaveBeenCalledWith(false, 4001, "Bad token");
    expect(orch.getAuthForRequest(req)).toBeUndefined();
  });

  it("when verify throws: rejects 500 + logs; no stash", async () => {
    const verify: VerifyClient<FakeUser> = async () => {
      throw new Error("boom");
    };
    const orch = new VerifyClientOrchestrator<FakeUser>(verify);
    const cb = orch.buildWsVerifyClient();

    const req = fakeReq({});
    const callback = vi.fn();

    cb({ origin: "x", secure: false, req }, callback);
    await new Promise((r) => setTimeout(r, 0));

    expect(callback).toHaveBeenCalledWith(false, 500, "Internal server error");
    expect(orch.getAuthForRequest(req)).toBeUndefined();
  });

  it("token=null when no ?token= query is present", async () => {
    const verify = vi.fn(async () => ({
      ok: true as const,
      user: { sub: "x" },
    }));
    const orch = new VerifyClientOrchestrator<FakeUser>(verify);
    const cb = orch.buildWsVerifyClient();

    const req = fakeReq({ url: "/ws" });
    cb({ origin: "x", secure: false, req }, vi.fn());
    await new Promise((r) => setTimeout(r, 0));

    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ token: null }),
    );
  });

  it("prefers x-forwarded-for for clientIp when present", async () => {
    const verify = vi.fn(async () => ({
      ok: true as const,
      user: { sub: "x" },
    }));
    const orch = new VerifyClientOrchestrator<FakeUser>(verify);
    const cb = orch.buildWsVerifyClient();

    const req = fakeReq({
      xForwardedFor: "203.0.113.1, 10.0.0.1",
      remoteAddress: "10.0.0.2",
    });
    cb({ origin: "x", secure: false, req }, vi.fn());
    await new Promise((r) => setTimeout(r, 0));

    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ clientIp: "203.0.113.1" }),
    );
  });
});

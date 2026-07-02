// Regression — WS auth fail-open on malformed verify results.
//
// The orchestrator used to check `if (result.ok)` — TRUTHY — with no
// shape guard, unlike its HTTP twin (`upload/http-handler.ts`'s
// `runVerify`, guarded by `isWellFormedAuthResult`). A plain-JS consumer
// resolving `{ ok: "yes" }` or `{ ok: true }` (no `user`) was ACCEPTED:
// with no `user`, `ConnectionHandler.deriveConnectionKey` falls back to
// `JSON.stringify(undefined)` — the literal `undefined`, not a string —
// so the connection registry gets keyed by `undefined` (all such
// connections collide/kick each other) and procedures run with
// `context.user === undefined` despite the typed contract.
//
// Pinned here: every malformed resolved value — truthy-but-not-true
// `ok`, `ok: true` without `user`, non-object, and a failure arm missing
// (or mistyping) the `code`/`reason` the orchestrator hands straight to
// `ws`'s abort callback — is rejected with the SAME 500 shape as the
// throw/rejection paths, and nothing is stashed. Well-formed results on
// both arms stay untouched (guards against over-reach; the accepted
// non-thenable case is additionally pinned in
// verify-client-sync-throw.test.ts). Same fakes as
// verify-client-orchestrator.test.ts.

import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "http";
import { Socket } from "net";

import type { Logger } from "@orpc-ws/shared";

import {
  VerifyClientOrchestrator,
  type VerifyClient,
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

/**
 * Build an orchestrator whose verify resolves the given (possibly
 * malformed) value. The cast models an untyped plain-JS consumer —
 * illegal per the typed contract, which is exactly the point.
 */
function orchestratorResolving(value: unknown, logger?: Logger) {
  const verify = (async () => value) as unknown as VerifyClient<FakeUser>;
  return new VerifyClientOrchestrator<FakeUser>(verify, logger ?? fakeLogger());
}

/** Run one upgrade through the orchestrator; settle the microtask. */
async function runUpgrade(orch: VerifyClientOrchestrator<FakeUser>) {
  const cb = orch.buildWsVerifyClient();
  const req = fakeReq();
  const callback = vi.fn();
  cb({ origin: "x", secure: false, req }, callback);
  await new Promise((r) => setTimeout(r, 0));
  return { req, callback };
}

describe("VerifyClientOrchestrator — malformed-result shape guard (fail-closed)", () => {
  it("truthy-but-not-true ok ({ ok: 'yes' }): rejected 500, logged, no stash", async () => {
    const logger = fakeLogger();
    const orch = orchestratorResolving({ ok: "yes", user: { sub: "u" } }, logger);

    const { req, callback } = await runUpgrade(orch);

    // Pre-fix, `if (result.ok)` accepted this — auth fail-open.
    expect(callback).toHaveBeenCalledWith(false, 500, "Internal server error");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(orch.getAuthForRequest(req)).toBeUndefined();
  });

  it("ok: true with no user: rejected 500, no stash (undefined-registry-key fail-open)", async () => {
    const orch = orchestratorResolving({ ok: true });

    const { req, callback } = await runUpgrade(orch);

    // Pre-fix this was accepted with `user === undefined`, and the
    // registry got keyed by JSON.stringify(undefined) === undefined.
    expect(callback).toHaveBeenCalledWith(false, 500, "Internal server error");
    expect(orch.getAuthForRequest(req)).toBeUndefined();
  });

  it("non-object resolved values (undefined / null / boolean): rejected 500, no stash", async () => {
    for (const value of [undefined, null, true]) {
      const orch = orchestratorResolving(value);
      const { req, callback } = await runUpgrade(orch);
      expect(callback).toHaveBeenCalledWith(
        false,
        500,
        "Internal server error",
      );
      expect(orch.getAuthForRequest(req)).toBeUndefined();
    }
  });

  it("failure arm missing code/reason ({ ok: false }): rejected 500, not (false, undefined, undefined)", async () => {
    const orch = orchestratorResolving({ ok: false });

    const { callback } = await runUpgrade(orch);

    // Pre-fix the orchestrator forwarded `callback(false, undefined,
    // undefined)`; ws then falls back to `code || 401` but computes
    // `Buffer.byteLength(undefined)` for codes without an
    // http.STATUS_CODES entry — the guard makes the arm's consumed
    // fields (`code: number`, `reason: string`) a precondition instead.
    expect(callback).toHaveBeenCalledWith(false, 500, "Internal server error");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("failure arm with mistyped code ({ ok: false, code: '401' }): rejected 500", async () => {
    const orch = orchestratorResolving({
      ok: false,
      code: "401",
      reason: "Bad token",
    });

    const { callback } = await runUpgrade(orch);

    expect(callback).toHaveBeenCalledWith(false, 500, "Internal server error");
  });

  it("well-formed ok result still accepted (guards against over-reach)", async () => {
    const user = { sub: "good" };
    const verify: VerifyClient<FakeUser> = async () => ({
      ok: true,
      user,
      connectionKey: "ck-1",
    });
    const orch = new VerifyClientOrchestrator<FakeUser>(verify, fakeLogger());

    const { req, callback } = await runUpgrade(orch);

    expect(callback).toHaveBeenCalledWith(true);
    expect(orch.getAuthForRequest(req)).toEqual({
      ok: true,
      user,
      connectionKey: "ck-1",
    });
  });

  it("well-formed failure result still forwards the consumer's code/reason", async () => {
    const verify: VerifyClient<FakeUser> = async () => ({
      ok: false,
      code: 4001,
      reason: "Bad token",
    });
    const orch = new VerifyClientOrchestrator<FakeUser>(verify, fakeLogger());

    const { callback } = await runUpgrade(orch);

    expect(callback).toHaveBeenCalledWith(false, 4001, "Bad token");
  });
});

// verifyClient timeout (decided 2026-07-02).
//
// A consumer verify promise that never settles previously pinned the
// pending upgrade socket forever — `ws` never times its verifyClient
// callback out. The orchestrator now races the verify against
// `verifyTimeoutMs` (default 30_000, `0` disables) on the injected Clock.
// Behaviors pinned:
//
//   1. Never-settling verify → fail closed (500) at the default deadline,
//      callback EXACTLY once. (Would fail pre-fix: callback never fired.)
//   2. A LATE resolve after the timeout is ignored — no second callback,
//      no auth stash.
//   3. A LATE reject after the timeout is ignored — no second callback.
//   4. Verify settling BEFORE the deadline clears the timer — normal
//      accept, and the dead deadline can never fire a late 500.
//   5. `verifyTimeoutMs: 0` disables the bound — no timer is scheduled.
//   6. A custom `verifyTimeoutMs` is honored.

import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "http";
import { Socket } from "net";

import { noopLogger } from "@orpc-ws/shared";
import type { Clock, TimerHandle } from "@orpc-ws/shared";

import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  VerifyClientOrchestrator,
  type VerifyClient,
  type VerifyClientResult,
} from "../verify-client-orchestrator.js";

interface FakeUser {
  sub: string;
}

// ---------- Fake clock (mirrors token-expiry-watchdog test conventions) ----------

interface FakeTimer {
  id: number;
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

function makeFakeClock(initial = 0): {
  clock: Clock;
  advance: (ms: number) => void;
  getPending: () => FakeTimer[];
} {
  let now = initial;
  let nextId = 1;
  const timers: FakeTimer[] = [];

  const toHandle = (t: FakeTimer): TimerHandle => t as unknown as TimerHandle;
  const fromHandle = (h: TimerHandle): FakeTimer => h as unknown as FakeTimer;

  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t: FakeTimer = {
        id: nextId++,
        fireAt: now + ms,
        fn,
        cancelled: false,
      };
      timers.push(t);
      return toHandle(t);
    },
    clearTimeout: (handle) => {
      fromHandle(handle).cancelled = true;
    },
    setInterval: () => {
      throw new Error("setInterval not expected in these tests");
    },
    clearInterval: () => {
      throw new Error("clearInterval not expected in these tests");
    },
  };

  // Synchronous advance — the timeout body is sync (log + callback).
  const advance = (ms: number): void => {
    now += ms;
    let safety = 1000;
    while (safety-- > 0) {
      const due = timers
        .filter((t) => !t.cancelled && t.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt);
      const next = due[0];
      if (!next) break;
      const idx = timers.indexOf(next);
      if (idx >= 0) timers.splice(idx, 1);
      next.fn();
    }
  };

  const getPending = () => timers.filter((t) => !t.cancelled).slice();

  return { clock, advance, getPending };
}

// ---------- Request + verify fakes (mirror verify-client-orchestrator.test.ts) ----------

function fakeReq(): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  return {
    url: "/ws?token=t1",
    headers: {},
    socket,
  } as unknown as IncomingMessage;
}

/** A verify whose settlement the test controls explicitly. */
function makeDeferredVerify(): {
  verify: VerifyClient<FakeUser>;
  resolve: (r: VerifyClientResult<FakeUser>) => void;
  reject: (e: unknown) => void;
} {
  let resolveFn!: (r: VerifyClientResult<FakeUser>) => void;
  let rejectFn!: (e: unknown) => void;
  const verify: VerifyClient<FakeUser> = () =>
    new Promise<VerifyClientResult<FakeUser>>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
  return {
    verify,
    resolve: (r) => resolveFn(r),
    reject: (e) => rejectFn(e),
  };
}

/** Flush the orchestrator's promise chain (real microtask/timer tick). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("VerifyClientOrchestrator — verifyTimeoutMs", () => {
  it("never-settling verify fails closed (500) at the DEFAULT deadline — callback exactly once", () => {
    const { clock, advance, getPending } = makeFakeClock();
    const { verify } = makeDeferredVerify();
    const orch = new VerifyClientOrchestrator<FakeUser>(verify, noopLogger, {
      clock,
    });
    const cb = orch.buildWsVerifyClient();
    const callback = vi.fn();

    cb({ origin: "x", secure: false, req: fakeReq() }, callback);

    // The deadline timer is armed on the injected clock.
    expect(getPending()).toHaveLength(1);

    // One ms short of the default deadline: still waiting, no callback.
    advance(DEFAULT_VERIFY_TIMEOUT_MS - 1);
    expect(callback).not.toHaveBeenCalled();

    // At the deadline: fail closed, same wire shape as a thrown verify.
    advance(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(false, 500, "Internal server error");

    // Timer consumed; nothing left armed.
    expect(getPending()).toHaveLength(0);
  });

  it("a LATE resolve after the timeout is ignored — no second callback, no stash", async () => {
    const { clock, advance } = makeFakeClock();
    const { verify, resolve } = makeDeferredVerify();
    const orch = new VerifyClientOrchestrator<FakeUser>(verify, noopLogger, {
      clock,
    });
    const cb = orch.buildWsVerifyClient();
    const callback = vi.fn();
    const req = fakeReq();

    cb({ origin: "x", secure: false, req }, callback);
    advance(DEFAULT_VERIFY_TIMEOUT_MS);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(false, 500, "Internal server error");

    // The verify finally resolves ok — AFTER the upgrade was rejected.
    resolve({ ok: true, user: { sub: "late" } });
    await flush();

    // Exactly-once discipline holds AND nothing was stashed for the
    // rejected handshake.
    expect(callback).toHaveBeenCalledTimes(1);
    expect(orch.getAuthForRequest(req)).toBeUndefined();
  });

  it("a LATE reject after the timeout is ignored — no second callback", async () => {
    const { clock, advance } = makeFakeClock();
    const { verify, reject } = makeDeferredVerify();
    const orch = new VerifyClientOrchestrator<FakeUser>(verify, noopLogger, {
      clock,
    });
    const cb = orch.buildWsVerifyClient();
    const callback = vi.fn();

    cb({ origin: "x", secure: false, req: fakeReq() }, callback);
    advance(DEFAULT_VERIFY_TIMEOUT_MS);
    expect(callback).toHaveBeenCalledTimes(1);

    reject(new Error("boom, eventually"));
    await flush();

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("verify settling BEFORE the deadline clears the timer — normal accept, no late 500", async () => {
    const { clock, advance, getPending } = makeFakeClock();
    const user = { sub: "u1" };
    const verify: VerifyClient<FakeUser> = async () => ({ ok: true, user });
    const orch = new VerifyClientOrchestrator<FakeUser>(verify, noopLogger, {
      clock,
    });
    const cb = orch.buildWsVerifyClient();
    const callback = vi.fn();
    const req = fakeReq();

    cb({ origin: "x", secure: false, req }, callback);
    // Armed while the verify is in flight...
    expect(getPending()).toHaveLength(1);
    await flush();

    // ...normal accept, and the timer was CLEARED on settle (no leak).
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(true);
    expect(getPending()).toHaveLength(0);
    expect(orch.getAuthForRequest(req)).toEqual({ ok: true, user });

    // The dead deadline can never fire a second (500) invocation.
    advance(DEFAULT_VERIFY_TIMEOUT_MS * 2);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("verifyTimeoutMs: 0 disables the bound — no timer scheduled, verify accepted whenever it settles", async () => {
    const { clock, advance, getPending } = makeFakeClock();
    const { verify, resolve } = makeDeferredVerify();
    const orch = new VerifyClientOrchestrator<FakeUser>(verify, noopLogger, {
      clock,
      verifyTimeoutMs: 0,
    });
    const cb = orch.buildWsVerifyClient();
    const callback = vi.fn();

    cb({ origin: "x", secure: false, req: fakeReq() }, callback);

    // No deadline armed at all.
    expect(getPending()).toHaveLength(0);

    // Even far past the (disabled) default deadline, still waiting...
    advance(DEFAULT_VERIFY_TIMEOUT_MS * 10);
    expect(callback).not.toHaveBeenCalled();

    // ...and a very late settle is accepted normally.
    resolve({ ok: true, user: { sub: "slow" } });
    await flush();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(true);
  });

  it("honours a custom verifyTimeoutMs", () => {
    const { clock, advance } = makeFakeClock();
    const { verify } = makeDeferredVerify();
    const orch = new VerifyClientOrchestrator<FakeUser>(verify, noopLogger, {
      clock,
      verifyTimeoutMs: 5_000,
    });
    const cb = orch.buildWsVerifyClient();
    const callback = vi.fn();

    cb({ origin: "x", secure: false, req: fakeReq() }, callback);

    advance(4_999);
    expect(callback).not.toHaveBeenCalled();

    advance(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(false, 500, "Internal server error");
  });
});

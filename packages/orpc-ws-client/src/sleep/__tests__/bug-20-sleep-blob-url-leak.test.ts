// Bug 20 regression — the sleep-detector's Blob URL must be revoked.
//
// The bug (docs/fable/bugs-review.md §BUG-10): `defaultWorkerFactory`
// called `URL.createObjectURL` per invocation and never revoked. The
// in-code justification — "one URL entry per detector *instance*" — was
// wrong: the factory runs once per `SleepDetector.start()`, and
// start()/stop() are explicitly designed to cycle ("start() after stop()
// spins up a fresh worker", pinned by sleep-detector.test.ts). Every
// start/stop cycle therefore leaked one blob URL.
//
// The fix: revoke once the worker has provably booted — its FIRST
// message can only arrive after the blob script loaded and ran, so a
// `{ once: true }` message listener is the portable safe point
// (revoking synchronously after `new Worker(url)` races the worker's
// fetch of its own script in some browsers).
//
// Known residual window (accepted): if `stop()` terminates the worker
// before its first tick (within ~5s of start), that cycle's URL is not
// revoked — same bounded cost as the pre-fix behavior, never worse.
//
// Harness: happy-dom provides `Blob` + `URL.createObjectURL`/
// `revokeObjectURL` but no `Worker`, so we stub a minimal fake Worker
// global that records its script URL and lets the test fire messages.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Clock } from "@orpc-ws/shared";

import { SleepDetector } from "../sleep-detector.js";
import { defaultWorkerFactory } from "../worker-source.js";

// ---------- Fake Worker global ----------

interface ListenerRecord {
  type: string;
  listener: (event: MessageEvent<unknown>) => void;
  once: boolean;
}

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly scriptUrl: string;
  readonly terminate = vi.fn();
  private listeners: ListenerRecord[] = [];

  constructor(scriptUrl: string | URL) {
    this.scriptUrl = String(scriptUrl);
    FakeWorker.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<unknown>) => void,
    options?: { once?: boolean },
  ): void {
    this.listeners.push({ type, listener, once: options?.once ?? false });
  }

  removeEventListener(
    type: string,
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners = this.listeners.filter(
      (l) => !(l.type === type && l.listener === listener),
    );
  }

  /** Deliver one message to all current listeners, honoring `once`. */
  emitMessage(data: unknown): void {
    const current = this.listeners.filter((l) => l.type === "message");
    this.listeners = this.listeners.filter(
      (l) => !(l.type === "message" && l.once),
    );
    const event = { data } as MessageEvent<unknown>;
    current.forEach((l) => l.listener(event));
  }
}

// SleepDetector only reads `clock.now()`; the timer seams throw to catch
// accidental raw-timer use (mirrors sleep-detector.test.ts).
const fakeClock: Clock = {
  now: () => 0,
  setTimeout: () => {
    throw new Error("setTimeout not expected");
  },
  clearTimeout: () => {
    throw new Error("clearTimeout not expected");
  },
  setInterval: () => {
    throw new Error("setInterval not expected");
  },
  clearInterval: () => {
    throw new Error("clearInterval not expected");
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWorker.instances = [];
});

function stubEnvironment(): {
  createSpy: ReturnType<typeof vi.spyOn>;
  revokeSpy: ReturnType<typeof vi.spyOn>;
} {
  vi.stubGlobal("Worker", FakeWorker);
  // Keep happy-dom's real createObjectURL (it returns unique blob: URLs);
  // the spy just lets us capture every URL it handed out.
  const createSpy = vi.spyOn(URL, "createObjectURL");
  const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
  return { createSpy, revokeSpy };
}

function createdUrls(createSpy: ReturnType<typeof vi.spyOn>): string[] {
  return createSpy.mock.results.map((r) => r.value as string);
}

function revokedUrls(revokeSpy: ReturnType<typeof vi.spyOn>): string[] {
  return revokeSpy.mock.calls.map((c) => c[0] as string);
}

// ---------- Tests ----------

describe("Bug 20 — sleep-detector Blob URL never revoked", () => {
  it("defaultWorkerFactory revokes the blob URL after the worker's first message — exactly once", () => {
    const { createSpy, revokeSpy } = stubEnvironment();

    const worker = defaultWorkerFactory() as unknown as FakeWorker;

    expect(createSpy).toHaveBeenCalledTimes(1);
    const url = createdUrls(createSpy)[0]!;
    // The worker was constructed FROM the created object URL...
    expect(worker.scriptUrl).toBe(url);
    // ...which must NOT be revoked before the worker proves it booted
    // (revoking earlier races the worker's script fetch).
    expect(revokeSpy).not.toHaveBeenCalled();

    // First tick = boot proof → revoke.
    worker.emitMessage({ ts: 1_000 });
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith(url);

    // Subsequent ticks must not re-revoke ({ once: true }).
    worker.emitMessage({ ts: 2_000 });
    worker.emitMessage({ ts: 3_000 });
    expect(revokeSpy).toHaveBeenCalledTimes(1);
  });

  it("a start/stop/start cycle of SleepDetector leaks no blob URLs", () => {
    const { createSpy, revokeSpy } = stubEnvironment();

    // No `workerFactory` override — this exercises the production
    // default (defaultWorkerFactory) against the stubbed Worker global.
    const detector = new SleepDetector({
      onWake: () => {},
      clock: fakeClock,
    });

    // Cycle 1.
    detector.start();
    expect(FakeWorker.instances).toHaveLength(1);
    FakeWorker.instances[0]!.emitMessage({ ts: 1_000 });
    detector.stop();
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);

    // Cycle 2 — pre-fix, this second factory call is where the leak
    // compounds (one un-revoked URL per cycle).
    detector.start();
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1]!.emitMessage({ ts: 2_000 });
    detector.stop();

    // Two URLs created, and BOTH revoked — nothing leaked across cycles.
    const created = createdUrls(createSpy);
    expect(created).toHaveLength(2);
    expect(new Set(created).size).toBe(2); // distinct URL per start()
    expect(revokedUrls(revokeSpy).sort()).toEqual([...created].sort());
  });
});

// Unit tests for the stable delegating server→client router
// (`createDelegatingClientRouter`, issue #7 Phase 1).
//
// The helper's whole reason to exist is LATE BINDING: build the router ONCE,
// keep its identity stable, yet have each call run the CURRENT handler. These
// tests prove (1) the router's STRUCTURE matches `names`, (2) a call DELEGATES
// to the live handler and forwards its value (sync and Promise), (3) FRESHNESS
// — the same router, after the backing map is mutated, runs the NEW handler
// (the load-bearing property), and (4) a call for an unregistered name throws.
//
// Invocation uses `call(...)` from `@orpc/server` — the codebase's in-process
// way to drive a router procedure without standing up a transport (the round
// trip over a real socket is covered in `client-router-host.test.ts`).

import { type AnyRouter, call, ORPCError, type os } from "@orpc/server";
import { describe, expect, it } from "vitest";

import {
  createDelegatingClientRouter,
  type DelegatingHandler,
} from "../delegating-router.js";

/**
 * Invoke a named leaf of a (dynamically-keyed) delegating router. The factory
 * returns `AnyRouter` — a union whose procedure arm has no string index — so we
 * narrow to a record of procedures for the lookup. This cast lives only in the
 * test; the production surface stays `AnyRouter`.
 */
function invoke(
  router: AnyRouter,
  name: string,
  input: unknown,
): Promise<unknown> {
  const leaf = (router as unknown as Record<string, Parameters<typeof call>[0]>)[
    name
  ];
  return call(leaf, input);
}

describe("createDelegatingClientRouter — structure", () => {
  it("exposes exactly the named procedures", () => {
    const router = createDelegatingClientRouter(["alpha", "beta"], () => ({}));

    // The router is the flat record we asked for: same keys as `names`, no more.
    expect(Object.keys(router as Record<string, unknown>).sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("is identity-stable across handler-map changes (no rebuild)", () => {
    // The component-facing contract: building never re-runs, so the reference
    // a caller hands to `createOrpcWsClient` is the same object regardless of
    // what the accessor later returns.
    let map: Record<string, DelegatingHandler> = { ping: () => "a" };
    const router = createDelegatingClientRouter(["ping"], () => map);
    const before = router;
    map = { ping: () => "b" };
    expect(router).toBe(before);
  });
});

describe("createDelegatingClientRouter — delegation", () => {
  it("delegates to the current handler and forwards its value", async () => {
    const router = createDelegatingClientRouter(["greet"], () => ({
      greet: (input) => `hello:${(input as { name: string }).name}`,
    }));

    await expect(invoke(router, "greet", { name: "ada" })).resolves.toBe(
      "hello:ada",
    );
  });

  it("resolves a handler that returns a Promise", async () => {
    const router = createDelegatingClientRouter(["slow"], () => ({
      slow: async (input) => `done:${input as string}`,
    }));

    await expect(invoke(router, "slow", "x")).resolves.toBe("done:x");
  });
});

describe("createDelegatingClientRouter — freshness (load-bearing)", () => {
  it("runs the LIVE handler per call, not a construction-time snapshot", async () => {
    // Back the accessor with a MUTABLE variable, build the router ONCE, then
    // swap the handler between calls on the SAME router. If the router captured
    // a snapshot, the second call would still return "A" — proving it does not.
    let handlers: Record<string, DelegatingHandler> = {
      tick: () => "A",
    };
    const router = createDelegatingClientRouter(["tick"], () => handlers);

    await expect(invoke(router, "tick", undefined)).resolves.toBe("A");

    // Mutate to a DIFFERENT handler identity; same router instance.
    handlers = { tick: () => "B" };

    await expect(invoke(router, "tick", undefined)).resolves.toBe("B");
  });
});

describe("createDelegatingClientRouter — missing handler", () => {
  it("throws an ORPCError(NOT_FOUND) naming the procedure when absent at call time", async () => {
    // `gone` is a declared procedure (in `names`) but the live map omits it —
    // a server→client call for it must fail loudly, not resolve undefined. The
    // throw is an `ORPCError` (code `NOT_FOUND`), NOT a plain `Error`, so over a
    // real s2c socket the descriptive message + code cross the wire intact: a
    // plain `Error` would be masked as a generic `INTERNAL_SERVER_ERROR` and the
    // message dropped. This in-process `call()` can only prove the thrown value;
    // the real-socket wire assertion belongs to Phase 2.
    const router = createDelegatingClientRouter(["gone"], () => ({}));

    const error = await invoke(router, "gone", undefined).then(
      () => {
        throw new Error("expected the missing-handler call to reject");
      },
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
    expect((error as ORPCError<string, unknown>).message).toMatch(
      /no handler registered for server→client procedure "gone"/,
    );
  });

  it("does NOT throw at construction when a name has no handler yet", () => {
    // Late binding: handlers may not exist until first render. Construction must
    // be inert — the error is deferred to an actual invocation.
    expect(() =>
      createDelegatingClientRouter(["later"], () => ({})),
    ).not.toThrow();
  });
});

// Sanity: the leaves are genuine ORPC procedures built off `os`, so they slot
// into the same router shape the heartbeat system router uses (a flat record of
// `os.handler` procedures), drivable by the same `call` entry point. This
// guards against a refactor that returns plain functions instead of procedures.
// (`invoke` already routes through `call`; an explicit reference `os.handler`
// procedure pins the expected leaf type.)
describe("createDelegatingClientRouter — leaf shape", () => {
  it("builds leaves that are ORPC procedures (callable via `call`)", async () => {
    type Leaf = ReturnType<typeof os.handler>;
    const router = createDelegatingClientRouter(["p"], () => ({
      p: () => "via-delegate",
    }));
    const leaf = (router as unknown as Record<string, Leaf>).p;

    await expect(call(leaf, undefined)).resolves.toBe("via-delegate");
  });
});

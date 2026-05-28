// createOrpcClientProxy regression tests.
//
// Pins Phase 1.4 invariants:
//   - LAZY: merely BUILDING the proxy must not call linkFactory.getLink().
//     The composition root (Phase 1.7) builds the proxy at
//     `createOrpcWsClient()` time, which can run BEFORE the WS handshake
//     completes; eager link construction would crash the wiring (because
//     the holder has no wrapper yet).
//   - TYPED PROXY CHAIN: writing `client.foo.bar` returns a proxy chain
//     (ORPC's own internal Proxy that aggregates the path). We assert the
//     chain is accessible without invoking anything.
//   - PACKAGE-INTERNAL RAW LINK: the returned typed proxy must NOT expose
//     `link`, `_link`, or `linkFactory` to a consumer. CLAUDE.md
//     "Public-surface review checklist: raw RPCLink is package-internal".
//     If a future ORPC release added one of these as a public field, this
//     test will catch the regression.
//
// We construct a minimal contract type via `oc` (the ORPC contract DSL)
// so the typed proxy has something real to navigate. Doing it inline keeps
// the test self-contained; no app-contract dep.

import { oc } from "@orpc/contract";
import { describe, expect, it, vi } from "vitest";

import { LinkFactory } from "../link-factory.js";
import { createOrpcClientProxy } from "../orpc-client.js";

// Minimal contract — one procedure under a namespace. Enough to exercise
// the proxy navigation; we never invoke it (that needs a real WS).
// `_contract` is prefixed because we only use its type; the runtime value
// is irrelevant. The DSL call still has to happen so the inferred type
// matches a real ORPC contract router shape.
const _contract = {
  foo: {
    bar: oc.route({ method: "POST", path: "/bar" }),
  },
};
type Contract = typeof _contract;

describe("createOrpcClientProxy", () => {
  it("is lazy: merely building the client does NOT call linkFactory.getLink()", () => {
    const getLinkSpy = vi.fn();
    // Build a LinkFactory whose getWebSocket would throw, then poison
    // getLink so we can detect any access. The proxy must not touch it.
    const factory = new LinkFactory(() => {
      throw new Error("getWebSocket should not be called during build");
    });
    // Replace getLink with a spy so we can detect eager calls.
    Object.assign(factory, { getLink: getLinkSpy });

    createOrpcClientProxy<Contract>(factory);

    expect(getLinkSpy).not.toHaveBeenCalled();
  });

  it("navigating client.foo.bar produces a proxy chain without invoking the link", () => {
    const getLinkSpy = vi.fn();
    const factory = new LinkFactory(() => {
      throw new Error("getWebSocket should not be called during navigation");
    });
    Object.assign(factory, { getLink: getLinkSpy });

    const client = createOrpcClientProxy<Contract>(factory);

    // ORPC's typed client uses a Proxy that resolves arbitrary paths;
    // walking the path with property access must NOT trigger anything.
    const foo = client.foo;
    const bar = foo.bar;

    expect(foo).toBeDefined();
    expect(bar).toBeDefined();
    // Path navigation is a pure read; no link access happens until an
    // actual call. (ORPC's Proxy returns a callable for any path; we
    // never invoke it here because that needs a real WS.)
    expect(getLinkSpy).not.toHaveBeenCalled();
  });

  it("the returned client does NOT expose raw link / linkFactory / _link properties", () => {
    // CLAUDE.md "Public-surface review checklist": the raw RPCLink and the
    // factory itself are package-internal. The consumer-facing typed proxy
    // surfaces ONLY the contract's nested procedure paths.
    //
    // ORPC's proxy returns SOMETHING for every property access (it can't
    // know which paths the contract declares without runtime info), so we
    // assert the "leaks" aren't anything dangerous — they don't carry the
    // factory or a callable that would let a consumer reach in.
    const factory = new LinkFactory(() => null);
    const linkSentinel = {
      __sentinel: "raw-link",
      call: vi.fn(),
    };
    Object.assign(factory, { getLink: vi.fn(() => linkSentinel) });

    const client = createOrpcClientProxy<Contract>(factory);

    // The factory must not be reachable through the public proxy by any
    // intuitive name a consumer might try.
    const asAny = client as unknown as Record<string, unknown>;
    expect(asAny.link).not.toBe(linkSentinel);
    expect(asAny._link).not.toBe(linkSentinel);
    expect(asAny.linkFactory).not.toBe(factory);
    expect(asAny.__factory).not.toBe(factory);

    // And specifically: the LinkFactory instance is not present anywhere
    // on the proxy. (We can't enumerate ORPC's proxy fully, but we can
    // confirm no commonly-guessed key returns it.)
    for (const key of ["factory", "_factory", "$link", "$factory"]) {
      expect((client as unknown as Record<string, unknown>)[key]).not.toBe(
        factory,
      );
    }
  });
});

// Typed ORPC client proxy.
//
// Phase 1.4 lift from `apps/web/src/lib/websocket/client/orpc-client.ts`.
//
// Differences from the source (de-app-ification):
//   1. Generic over `<TContract>` — no hard-coded `typeof appContract` import
//      from the consumer app. Consumers (and Phase 1.7's composition root)
//      supply their own contract type. The return type is
//      `ContractRouterClient<TContract>` so consumer code keeps end-to-end
//      typing through the proxy.
//   2. Renamed `createORPCClientWithLazyLink` →
//      `createOrpcClientProxy` to match the package's casing convention
//      (`createOrpcWsClient` etc.) and to describe the mechanism, not the
//      side effect.
//   3. No app imports.
//
// Why the Proxy wrapper at all?
// `RPCLink` requires an OPEN `WebSocket` at construction time (it captures
// the reference and assumes it's usable). The library is built around lazy
// link creation so the typed client object can be returned from
// `createOrpcWsClient()` BEFORE the WS handshake completes — consumers
// pattern-match the returned object into React contexts, modules, etc.,
// and only invoke methods later. The Proxy here defers `linkFactory.getLink()`
// until first method-path access, at which point the WS is (typically)
// open and the underlying link can be constructed.
//
// Crucially: the Proxy is consumed by `createORPCClient`, which itself
// constructs ANOTHER proxy (the typed `.foo.bar(...)` chain). Property
// reads on the OUTER proxy only happen when the ORPC client invokes
// `link.call(...)` — i.e. at the moment of an actual RPC call. Merely
// holding a reference to `client` or writing `client.foo.bar` (without
// invoking) does NOT trigger link construction.

import { createORPCClient } from "@orpc/client";
import type { RPCLink } from "@orpc/client/websocket";
import type { AnyContractRouter, ContractRouterClient } from "@orpc/contract";

import type { LinkFactory } from "./link-factory.js";

/**
 * Build the typed `.rpc` Proxy that goes on the public `OrpcWsClient`.
 *
 * The raw `LinkFactory` and the underlying `RPCLink` are PACKAGE-INTERNAL
 * (CLAUDE.md "Public-surface review checklist: raw RPCLink is package-
 * internal; not on OrpcWsClient"). The composition root keeps the factory
 * in a private field for the heartbeat-subscriber's `link.call(...)` and
 * TokenRefreshHandler's `linkClearer`; the consumer only ever sees the
 * `ContractRouterClient<TContract>` returned here.
 *
 * @typeParam TContract The consumer's contract router type (e.g.
 *   `typeof appContract`). The proxy carries it end-to-end so calls like
 *   `client.foo.bar({ … })` are fully typed against the contract.
 */
export function createOrpcClientProxy<TContract extends AnyContractRouter>(
  linkFactory: LinkFactory,
): ContractRouterClient<TContract> {
  // Outer proxy: lazy adapter over the link. ORPC's `createORPCClient`
  // accesses `call` (and possibly other methods in the future) on this
  // object — every property access reroutes to the live link via the
  // factory. The empty object base is fine because every access goes
  // through the trap.
  //
  // The `Record<string, never>` context generic mirrors LinkFactory's
  // current link typing. If/when the library surfaces ORPC client-context
  // typing, both call sites widen together.
  const lazyLink = new Proxy({} as RPCLink<Record<string, never>>, {
    get(_target, prop, _receiver) {
      const link = linkFactory.getLink();
      // The link is a class instance; method properties need to be bound
      // to it so `this` inside StandardLink.call() resolves correctly.
      // (If we returned the unbound function, ORPC's call site would
      // invoke it with the proxy as `this` and the internal `this.sender`
      // lookup would throw.)
      const value = (link as unknown as Record<string | symbol, unknown>)[
        prop
      ];
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(link);
      }
      return value;
    },
  });

  return createORPCClient<ContractRouterClient<TContract>>(lazyLink);
}

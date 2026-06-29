// A STABLE server→client (`s2c`) router whose leaf handlers delegate, per call,
// through a caller-supplied accessor.
//
// THE PROBLEM this solves (the `<OrpcWs>` React component, issue #7 Phase 1).
// The consumer's `clientRouter` is fixed at `createOrpcWsClient` construction
// time: the router IDENTITY is captured once, and the per-connection bidi wiring
// (`bidi/client-bidi.ts` → `createClientRouterHost`) hosts THAT instance for the
// life of each socket. Rebuilding the router means rebuilding the client — which
// `<OrpcWs>` must never do, because a router-identity change there would force a
// fresh wrapper + mux + host on every render (a reconnect storm). But React
// server→client handlers, defined inside render so they can close over hooks and
// context, get FRESH function identities every render. So the two requirements
// collide: the router must be identity-STABLE, yet each `s2c` call must run the
// CURRENT (latest-render) handler.
//
// THE SOLUTION (proven in the design spike — ZERO core behavior change). Build
// ONE router off a bare `os`, ONCE, with a fixed leaf per name. Each leaf does
// not close over a handler; it closes over `getHandlers` — an accessor the
// component points at a ref it updates every render. The router identity stays
// stable (no rebuild, no reconnect), while every server→client invocation reads
// the LIVE handler map at call time and dispatches to whatever is current. The
// typed handler-map ↔ leaf mapping is the Phase-2 React adapter's job; this
// helper is the framework-free core primitive it builds on.
//
// FLAT for v1: a single-level handler map (no nested namespaces). Nesting is a
// later, purely additive concern — do NOT add it here.

import { type AnyRouter, ORPCError, os } from "@orpc/server";

/**
 * A single server→client handler: it receives the (untyped at this boundary)
 * call input and returns the procedure result, sync or as a Promise. `unknown`
 * in/out is INTENTIONAL — the delegating router is structural glue; the typed
 * surface is layered on by the Phase-2 React adapter, not here.
 */
export type DelegatingHandler = (input: unknown) => unknown;

/**
 * Build a stable, flat ORPC `s2c` router that delegates every call to the
 * CURRENT handler map.
 *
 * The returned router has exactly one procedure per entry in `names`, so its
 * STRUCTURE is fixed by `names` and its IDENTITY never changes — it can be
 * handed to `createOrpcWsClient`'s `clientRouter` once and hosted for the life
 * of the client (see {@link createClientRouterHost}). At INVOCATION time each
 * leaf calls `getHandlers()` and dispatches to the named handler, so a handler
 * swapped between calls (the React re-render case) is picked up on the next
 * call — the router reads the live map, never a snapshot.
 *
 * @param names  The STABLE set of procedure keys. Defines the router's fixed
 *   shape; pass the full set up front, since it cannot grow after construction
 *   without changing the router identity (the very thing this helper avoids).
 * @param getHandlers  Returns the CURRENT handler map. Called fresh on EVERY
 *   invocation (never cached) so late-bound / re-rendered handlers take effect.
 *   May return different function identities across calls; may omit a name (see
 *   the missing-handler behavior below).
 * @returns An {@link AnyRouter} — the exact type `createClientRouterHost` /
 *   `createOrpcWsClient`'s `clientRouter` accepts. Built off a bare `os`, so it
 *   carries no consumer context type.
 *
 * @throws an `ORPCError("NOT_FOUND")` at CALL time (not construction) when an
 *   invoked procedure's name is absent from the current map. A server calling an
 *   unregistered procedure is a protocol/usage error: we fail loudly rather than
 *   silently resolving `undefined`, which would surface as a confusing success
 *   on the server side. `ORPCError` (not a plain `Error`) so the code + message
 *   cross the s2c wire intact instead of being masked as a generic
 *   `INTERNAL_SERVER_ERROR`.
 */
export function createDelegatingClientRouter(
  names: readonly string[],
  getHandlers: () => Record<string, DelegatingHandler>,
): AnyRouter {
  // Build off a bare `os` (no `$context` narrowing) so leaves inherit no
  // consumer context — mirrors the heartbeat system router idiom
  // (`@orpc-ws/server` `heartbeat/system-router.ts`).
  // `Object.create(null)` (not `{}`) so a `name` of `"__proto__"` lands as an
  // own key instead of hitting the prototype setter and vanishing from `for…in`.
  const router: Record<string, ReturnType<typeof buildLeaf>> =
    Object.create(null);
  for (const name of names) {
    router[name] = buildLeaf(name, getHandlers);
  }

  // No cast needed: each leaf is a real `os.handler` Procedure, and a
  // `Record<string, Procedure>` is directly assignable to `AnyRouter` (whose
  // object arm subsumes the `Procedure` arm). The `: AnyRouter` return
  // annotation performs that assignability check.
  return router;
}

/**
 * Build one delegating leaf. Closes over `name` + `getHandlers` only — NOT over
 * any handler — so the live map is consulted on each call. Extracted so the
 * accumulator above can name its element type via `ReturnType` (no `any`).
 */
function buildLeaf(
  name: string,
  getHandlers: () => Record<string, DelegatingHandler>,
) {
  return os.handler(({ input }: { input: unknown }): unknown => {
    const map = getHandlers();
    const handler = map[name];
    if (typeof handler !== "function") {
      // Fail loudly: a server→client call for a procedure the consumer never
      // registered is a usage/protocol error, not a benign no-op. Throw an
      // `ORPCError` (not a plain `Error`) so the code + message survive the
      // wire: over a real s2c socket the browser is the callee, and ORPC maps
      // a plain `Error` to a generic `INTERNAL_SERVER_ERROR` ("Internal server
      // error"), dropping this descriptive message before it reaches the
      // server-side caller. `NOT_FOUND` is the right semantic — the procedure
      // isn't registered on the callee.
      throw new ORPCError("NOT_FOUND", {
        message:
          `[orpc-ws] delegating clientRouter: no handler registered for ` +
          `server→client procedure "${name}". Declared procedures: ` +
          `[${Object.keys(map).join(", ")}].`,
      });
    }
    // Forward the handler's return verbatim — ORPC awaits a Promise result, so
    // sync and async handlers both work without special-casing here.
    return handler(input);
  });
}

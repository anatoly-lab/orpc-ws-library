// `createServerHandlerHook` — a TYPED, feature-local server→client handler hook.
//
// THE SHAPE (and why a FACTORY). Server→client procedures are typed by the
// consumer's CLIENT contract (`clientContract` / `TClientContract`). Rather than
// thread that contract generic through every call site, the consumer binds it
// ONCE — `export const useServerHandler = createServerHandlerHook<MyClient>()` —
// and the returned hook is fully typed: `name` is constrained to the contract's
// procedure keys, and the handler's input/output are pinned per `name`. (Same
// "bind the generic once, get a typed hook" move as a typed `useSelector`.)
//
// THE BRIDGE TO THE CORE. The hook does NOT build a router; it registers its
// implementation into the live registry that `<OrpcWs>` owns (via
// `ServerHandlerContext`). The router's procedure NAME SET is frozen at
// `<OrpcWs>` construction from `clientContract` (the attach-before-open
// invariant — the router shape can't grow after connect); this hook only
// populates IMPLEMENTATIONS afterward. So a handler can mount/unmount/move in the
// tree freely without ever rebuilding the client.

import { useContext, useEffect, useRef } from "react";

import type {
  AnyContractRouter,
  InferContractRouterInputs,
  InferContractRouterOutputs,
} from "@orpc/contract";

import type { DelegatingHandler } from "@orpc-ws/client";

import { ServerHandlerContext } from "./server-handler-context.js";

/**
 * The output type for procedure `K` of client contract `T` (or `never`). Mirrors
 * the contract→type derivation: TS cannot prove `keyof Inputs === keyof Outputs`
 * for a generic `T`, so the output is resolved through this conditional
 * (`InferContractRouterOutputs<T>[K]` when `K` is a known output key, else
 * `never`). It types a handler's RETURN per `name`, the same way
 * `InferContractRouterInputs<T>[K]` types its input — together they give the
 * fully-typed handler signature derived from the `clientContract`.
 */
type ServerHandlerOutput<T extends AnyContractRouter, K> =
  K extends keyof InferContractRouterOutputs<T>
    ? InferContractRouterOutputs<T>[K]
    : never;

/**
 * Bind a client contract `TClientContract` and return a typed `useServerHandler`
 * hook for it. Call this ONCE per app (module scope) and import the returned
 * hook wherever a server→client procedure is implemented.
 *
 * @typeParam TClientContract  The SERVER→CLIENT contract (e.g. `typeof
 *   clientContract`). Its procedure keys constrain `name`; its inferred
 *   inputs/outputs type the handler.
 *
 * @example
 *   // lib/ws.ts
 *   export const useServerHandler = createServerHandlerHook<ClientContract>();
 *   // any component under <OrpcWs clientContract={clientContract}>
 *   useServerHandler("showToast", ({ text }) => { toast(text); return { shown: true }; });
 */
export function createServerHandlerHook<
  TClientContract extends AnyContractRouter,
>() {
  /**
   * Register a server→client handler for `name` for as long as the calling
   * component is mounted. The handler may be a FRESH closure every render (it
   * closes over component state); a render-updated ref keeps the registered
   * wrapper pointing at the LATEST one without re-registering, so re-renders
   * never churn the registry. Must be used under an `<OrpcWs clientContract=…>`
   * ancestor — throws otherwise.
   */
  return function useServerHandler<
    K extends keyof InferContractRouterInputs<TClientContract>,
  >(
    name: K,
    handler: (
      input: InferContractRouterInputs<TClientContract>[K],
    ) =>
      | ServerHandlerOutput<TClientContract, K>
      | Promise<ServerHandlerOutput<TClientContract, K>>,
  ): void {
    const register = useContext(ServerHandlerContext);
    if (!register) {
      // Early throw (matches `useOrpcWs`): a missing provider is a wiring bug,
      // not a recoverable state — fail loudly rather than silently no-op.
      throw new Error(
        "useServerHandler must be used inside <OrpcWs> with a clientContract. " +
          "Pass `clientContract` to <OrpcWs> and call this hook in a descendant.",
      );
    }

    // Latest-closure ref: updated EVERY render so the (stable) registered
    // wrapper always invokes the current handler. Same pattern the old
    // render-updated handler ref used — a new handler identity must NOT force a
    // re-registration.
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    // Register on mount; dispose on unmount. Deps are `[name, register]` — NOT
    // `[handler]` — so an every-render handler identity does not re-register.
    // `register` is identity-stable (built once in `<OrpcWs>`); `name` is
    // normally a literal. Touching the registry ONLY here (an effect, never
    // during render) keeps the hook SSR-safe. Re-registration is cheap (a Map
    // set), so unlike the WS client's dispose there is no microtask-defer dance.
    useEffect(() => {
      // Stable wrapper: closes over `handlerRef` (not a specific handler), so
      // its identity is constant for the life of this effect. The cast crosses
      // the core's erased `(input: unknown)` boundary into the typed input — the
      // single structural-glue cast; the typed surface is the hook's params.
      const wrapper: DelegatingHandler = (input) =>
        handlerRef.current(
          input as InferContractRouterInputs<TClientContract>[K],
        );
      return register(name as string, wrapper);
    }, [name, register]);
  };
}

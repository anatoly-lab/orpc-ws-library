// React adapter — `<OrpcWs>` construct-and-own provider (issue #7 Phase 2).
//
// `<OrpcWsProvider>` takes a PRE-BUILT client; the consumer owns construction,
// lifecycle, and (for server→client / "bidi") the `clientRouter`. `<OrpcWs>` is
// the higher-level complement: it CONSTRUCTS the client from props, owns its
// connect/dispose lifecycle, and renders `<OrpcWsProvider>` underneath — so
// `useOrpcWs` / `useConnectionState` / `useWsSubscription` work UNCHANGED below
// it (composition, not a second context).
//
// THE BIDI CHALLENGE. `clientRouter` is fixed at `createOrpcWsClient`
// construction (rebuilding it rebuilds the client → a reconnect storm), yet
// React server→client handlers are defined in render so they can close over
// hooks/state — fresh function identities every render. SOLUTION (zero core
// change): the consumer passes a FLAT handler-map prop (`clientRouter`); we keep
// it in a ref updated DURING RENDER, and build ONE identity-stable delegating
// router (the core's `createDelegatingClientRouter`) whose leaves read that ref
// at call time. The client is built ONCE; every server→client call dispatches to
// the latest-render handler. FLAT only for v1 — see `ClientRouterHandlers`.

import {
  useEffect,
  useRef,
  type ReactNode,
} from "react";

import type {
  AnyContractRouter,
  InferContractRouterInputs,
  InferContractRouterOutputs,
} from "@orpc/contract";

import {
  createOrpcWsClient,
  createDelegatingClientRouter,
  type DelegatingHandler,
  type OrpcWsClient,
  type OrpcWsClientOptions,
} from "@orpc-ws/client";

import { OrpcWsProvider } from "./provider.js";
import { useConnectionState } from "./use-connection-state.js";

/**
 * The typed, FLAT server→client handler map. For each procedure `K` in the
 * client contract `TClientContract`, a handler taking that procedure's input and
 * returning its output (sync or async). The input/output types are derived from
 * the contract via ORPC's `InferContractRouterInputs` / `InferContractRouterOutputs`
 * (the documented contract→type utilities), so renaming a procedure in the
 * contract surfaces as a compile error here, not a runtime miss.
 *
 * FLAT for v1: a single level of procedure keys, mirroring
 * `createDelegatingClientRouter`'s flat shape. Nested namespaces are a later,
 * purely-additive concern — do NOT rely on nesting here.
 *
 * Handlers may be fresh closures every render (they close over component state);
 * `<OrpcWs>` reads them through a render-updated ref, so a new identity does NOT
 * rebuild the client. The default `never` is the bidi-OFF case: omit the
 * `clientRouter` prop and the component constructs a plain one-way client.
 */
export type ClientRouterHandlers<
  TClientContract extends AnyContractRouter = never,
> = {
  // Key over the INPUTS map (not `TClientContract` directly): for a router,
  // `InferContractRouterInputs<T>` is `{ [K in keyof T]: … }`, so its keys are
  // the procedure keys, and `Inputs[K]` is provably valid inside the mapping.
  // The matching output is resolved via `OutputOf` (TS can't infer that
  // `keyof Inputs === keyof Outputs` for a generic `T`, hence the guard).
  [K in keyof InferContractRouterInputs<TClientContract>]: (
    input: InferContractRouterInputs<TClientContract>[K],
  ) => OutputOf<TClientContract, K> | Promise<OutputOf<TClientContract, K>>;
};

/** The output type for procedure `K` of a client contract `T` (or `never`). */
type OutputOf<T extends AnyContractRouter, K> = K extends keyof InferContractRouterOutputs<T>
  ? InferContractRouterOutputs<T>[K]
  : never;

/**
 * Props for `<OrpcWs>`. Carries every `createOrpcWsClient` CONSTRUCTION option
 * (`url`, `tokenProvider`, `onEvent`, `reconnect`, `logger`, `uploads`, …) —
 * those are read ONCE at construction and never re-read (changing them across
 * renders has no effect; build a new tree to change them) — MINUS the bidi
 * `clientRouter` / `clientContext`, which `<OrpcWs>` owns and supplies to the
 * core itself (the delegating router + empty context).
 *
 * Generic only over `TClientContract` (the only thing that types a PROP — the
 * `clientRouter` handler map), which is also {@link OrpcWs}'s SOLE generic. The
 * consumer's CLIENT→SERVER contract is NOT a type parameter anywhere here: the
 * internally-built client is erased to `OrpcWsClient<AnyContractRouter>` and the
 * c2s contract is asserted only at the read site via `useOrpcWs<MyContract>()`.
 *
 * @typeParam TClientContract  The SERVER→CLIENT (bidi) contract that types the
 *   `clientRouter` handler map. Defaults to `never` (bidi off).
 */
export interface OrpcWsProps<
  TClientContract extends AnyContractRouter = never,
> extends Omit<OrpcWsClientOptions, "clientRouter" | "clientContext"> {
  /**
   * Flat, React-aware server→client handler map. Optional — omit for a one-way
   * (no bidi) client; `<OrpcWs>` still works as a construct-and-own provider.
   * Defined in render so handlers can close over hooks/state; read through a
   * render-updated ref so the client is NOT rebuilt per render. The set of
   * procedure KEYS is fixed at construction (the first render) — adding keys
   * later has no effect (FLAT v1; the router shape is identity-stable).
   */
  clientRouter?: ClientRouterHandlers<TClientContract>;
  /**
   * Rendered until the WS reaches `connected`. Omit to always render
   * `children` (even pre-connect); the connection state is still observable
   * below via `useConnectionState`.
   */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Lazy-init ref: run `init()` EXACTLY ONCE and return its result as a
 * guaranteed non-null `T`.
 *
 * WHY (not `useState(() => init())`): React DELIBERATELY double-invokes
 * `useState`/`useMemo`/`useReducer` initializers in StrictMode + dev to surface
 * impure ones (react.dev, `useState` caveats — "React will call your initializer
 * function twice … The result from one of the calls will be ignored"). For a
 * factory that builds a whole client object graph + the delegating router that
 * means a SECOND, orphaned client is constructed on every dev mount. This is the
 * documented "avoiding recreating the initial value" pattern (react.dev, `useRef`
 * caveats): the ref OBJECT persists across StrictMode's double render-invoke, so
 * the `=== null` guard short-circuits the second pass and `init()` runs once.
 *
 * The value is BOXED in `{ v }` so the sentinel is the box, not the value —
 * `init()` may legitimately return `null`/`undefined` without re-running — and
 * the read is a clean non-null `T`, so callers don't scatter `!` over every use.
 */
function useLazyRef<T>(init: () => T): T {
  const ref = useRef<{ v: T } | null>(null);
  if (ref.current === null) ref.current = { v: init() };
  return ref.current.v;
}

/**
 * Construct-and-own ORPC-WS provider. Builds the client from props ONCE,
 * connects on mount / disposes on unmount, and exposes it to descendants via
 * `<OrpcWsProvider>` so the existing hooks work unchanged below it.
 *
 * The component takes a SINGLE generic — `TClientContract`, the server→client
 * (bidi) contract that types the `clientRouter` handler map. The consumer's
 * CLIENT→SERVER contract is NOT a generic here: the internally-built client is
 * stored as `OrpcWsClient<AnyContractRouter>` and the c2s contract is asserted
 * at the READ site by `useOrpcWs<MyContract>()`. (A first, decorative
 * `TContract` generic used to exist; it typed nothing observable, yet, being
 * first, silently swallowed a `<OrpcWs<MyClientContract>>` into `TContract` and
 * left the handler map untyped — so it was removed.)
 *
 * @example one-way (no bidi)
 *   <OrpcWs url={WS_URL} tokenProvider={tp} fallback={<Spinner />}>
 *     <App />
 *   </OrpcWs>
 *
 * @example bidi (server→client) — supply the client contract as the SOLE generic
 *   <OrpcWs<MyClientContract>
 *     url={WS_URL}
 *     clientRouter={{ notify: (msg) => toast(msg) }}
 *   >
 *     <App />
 *   </OrpcWs>
 */
export function OrpcWs<
  TClientContract extends AnyContractRouter = never,
>(props: OrpcWsProps<TClientContract>): ReactNode {
  const { clientRouter, fallback, children, ...constructionOpts } = props;

  // Render-updated ref: the delegating router's leaves read THIS on every
  // server→client call, so the latest-render handler runs without rebuilding
  // the client. Assigning during render (not in an effect) is the same
  // latest-closure pattern `useWsSubscription` uses for its selector/options
  // refs — the ref must already hold this render's handlers before any call
  // that this render enables can fire.
  //
  // The cast crosses the typed handler map → the core's intentionally
  // `unknown`-typed `DelegatingHandler` boundary (function-param variance makes
  // it non-assignable directly). It is the single structural-glue cast; the
  // typed surface lives in `ClientRouterHandlers` / the leaves' inputs.
  const handlersRef = useRef<Record<string, DelegatingHandler>>({});
  handlersRef.current = (clientRouter ??
    {}) as unknown as Record<string, DelegatingHandler>;

  // Build the client EXACTLY ONCE via a ref-guard lazy-init (`useLazyRef`), NOT
  // a `useState` initializer: StrictMode + dev DOUBLE-INVOKES `useState`
  // initializers to surface impure ones, which here would build (and orphan) a
  // SECOND whole client graph + delegating router on every dev mount — exactly
  // the wasteful churn the ref-guard avoids (it constructs on the first render
  // pass and short-circuits the second). Captures the FIRST render's
  // construction options + the procedure key set — both are initial-only by
  // contract. When `clientRouter` is present we hand the core a STABLE
  // delegating router (identity never changes → no reconnect on re-render); when
  // absent we build a plain one-way client so `<OrpcWs>` still serves as a
  // construct-and-own provider. Typed as `OrpcWsClient<AnyContractRouter>` — the
  // c2s contract is erased here (it types nothing in this component) and
  // re-asserted at the read site by `useOrpcWs<MyContract>()`. `AnyContractRouter`
  // as the c2s generic is the loose/erased case `createOrpcWsClient` accepts.
  const client = useLazyRef<OrpcWsClient<AnyContractRouter>>(() => {
    if (clientRouter) {
      // Names fixed here (first render). The router's STRUCTURE is fixed by
      // this key set; its identity must never change (the very thing that would
      // force a client rebuild), so late-added keys are intentionally ignored.
      const names = Object.keys(clientRouter);
      const delegating = createDelegatingClientRouter(
        names,
        () => handlersRef.current,
      );
      return createOrpcWsClient<AnyContractRouter, typeof delegating>({
        ...constructionOpts,
        clientRouter: delegating,
      });
    }
    return createOrpcWsClient<AnyContractRouter>({ ...constructionOpts });
  });

  // Lifecycle: connect on mount, dispose on unmount — StrictMode-safe.
  //
  // A disposed client is TERMINAL (cannot reconnect — see `OrpcWsClient`). React
  // 18/19 StrictMode runs effects mount→unmount→remount on the SAME (build-once)
  // client; a synchronous dispose-on-unmount would hand the remount a dead
  // client. We instead DEFER dispose to a microtask guarded by a flag: the
  // remount's setup (below) runs synchronously within the same passive-effect
  // flush and clears the flag BEFORE the microtask runs, so the dispose is
  // cancelled and the connection is kept alive. A real unmount has no remount,
  // so the flag stays set and the microtask disposes. Net effect: ONE stable
  // connection — no dev-only connect→dispose→reconnect churn, which is exactly
  // the reconnect-storm behavior this library exists to prevent. (A queued
  // microtask can't be unscheduled, so the flag — not the task — is the cancel.)
  //
  // LIMITATION (out of scope): the cancellation relies on cleanup→setup running
  // in the SAME task — true for mount/unmount and StrictMode's synchronous
  // double-invoke. React 19's experimental `<Activity>`/Offscreen can destroy
  // then later re-create a fiber's effects across SEPARATE tasks; there a "hide"
  // would let the microtask dispose, and a later "show" would `connect()` a dead
  // (terminal) client. We don't support `<Activity>` wrapping `<OrpcWs>` today.
  const pendingDisposeRef = useRef(false);
  useEffect(() => {
    pendingDisposeRef.current = false; // cancel a deferred dispose, if any
    client.connect(); // idempotent — no-op if already connecting/connected
    return () => {
      pendingDisposeRef.current = true;
      queueMicrotask(() => {
        if (pendingDisposeRef.current) {
          pendingDisposeRef.current = false;
          client.dispose();
        }
      });
    };
  }, [client]);

  // Reactive gate for `fallback`. Subscribing here also means a child rendered
  // below only mounts once connected (when a `fallback` is set).
  const conn = useConnectionState(client);
  const showChildren = conn.status === "connected" || fallback === undefined;

  // `client` is already `OrpcWsClient<AnyContractRouter>` — the exact erased
  // contract type the context stores; `useOrpcWs<MyContract>()` re-asserts the
  // c2s contract at the read site (the pattern the provider documents). No cast.
  return (
    <OrpcWsProvider client={client}>
      {showChildren ? children : fallback}
    </OrpcWsProvider>
  );
}

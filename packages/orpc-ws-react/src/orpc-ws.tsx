// React adapter — `<OrpcWs>` construct-and-own provider (issue #7 Phase 2).
//
// `<OrpcWsProvider>` takes a PRE-BUILT client; the consumer owns construction,
// lifecycle, and (for server→client / "bidi") the `clientRouter`. `<OrpcWs>` is
// the higher-level complement: it CONSTRUCTS the client from props, owns its
// connect/dispose lifecycle, and renders `<OrpcWsProvider>` underneath — so
// `useOrpcWs` / `useConnectionState` / `useWsSubscription` work UNCHANGED below
// it (composition, not a second context).
//
// THE BIDI CHALLENGE, AND THE FEATURE-LOCAL DESIGN. `clientRouter` is fixed at
// `createOrpcWsClient` construction (rebuilding it rebuilds the client → a
// reconnect storm). React server→client handlers, by contrast, are defined in
// render (so they can close over hooks/state) AND live wherever the feature that
// owns them lives in the tree — registered AFTER `<OrpcWs>` mounts.
//
// SOLUTION (zero core change): `<OrpcWs>` takes the `clientContract` VALUE — the
// runtime contract router (e.g. `oc.router({ showToast })`). Its KEY SET is
// known at construction, so we freeze the hosted router's NAME SET from it (the
// attach-before-open invariant: the router shape can't grow after connect). We
// build ONE identity-stable delegating router (the core's
// `createDelegatingClientRouter`) whose leaves read a LIVE registry per call.
// Descendant components fill that registry AFTER construction via
// `useServerHandler` (over `ServerHandlerContext`). Client built ONCE; every
// server→client call dispatches to the currently-mounted, latest-render handler.
// FLAT only for v1 (matches the delegating router's flat constraint).

import {
  useEffect,
  useRef,
  type ReactNode,
} from "react";

import { isContractProcedure } from "@orpc/contract";
import type { AnyContractRouter } from "@orpc/contract";

import {
  createOrpcWsClient,
  createDelegatingClientRouter,
  noopLogger,
  type DelegatingHandler,
  type Logger,
  type OrpcWsClient,
  type OrpcWsClientOptions,
} from "@orpc-ws/client";

import { OrpcWsProvider } from "./provider.js";
import { useConnectionState } from "./use-connection-state.js";
import {
  ServerHandlerContext,
  type RegisterServerHandler,
} from "./server-handler-context.js";

/**
 * Props for `<OrpcWs>`. Carries every `createOrpcWsClient` CONSTRUCTION option
 * (`url`, `tokenProvider`, `onEvent`, `reconnect`, `logger`, `uploads`, …) —
 * those are read ONCE at construction and never re-read (changing them across
 * renders has no effect; build a new tree to change them) — MINUS the bidi
 * `clientRouter` / `clientContext`, which `<OrpcWs>` owns and supplies to the
 * core itself (the delegating router built from `clientContract` + empty
 * context).
 *
 * Generic only over `TClientContract`, which INFERS from the `clientContract`
 * prop value — so `<OrpcWs clientContract={cc}>` needs no explicit generic. The
 * consumer's CLIENT→SERVER contract is NOT a type parameter here: the
 * internally-built client is erased to `OrpcWsClient<AnyContractRouter>` and the
 * c2s contract is asserted only at the read site via `useOrpcWs<MyContract>()`.
 *
 * @typeParam TClientContract  The SERVER→CLIENT (bidi) contract. Inferred from
 *   `clientContract`; defaults to `never` (bidi off) when the prop is omitted.
 */
export interface OrpcWsProps<
  TClientContract extends AnyContractRouter = never,
> extends Omit<OrpcWsClientOptions, "clientRouter" | "clientContext"> {
  /**
   * The SERVER→CLIENT contract ROUTER VALUE (e.g. `oc.router({ showToast })`).
   * Bidi is ON iff this is present. Its procedure KEYS define the hosted
   * router's fixed shape (frozen at construction); the IMPLEMENTATIONS are
   * supplied by descendants via the bound `useServerHandler` hook. Omit for a
   * one-way (no bidi) client — `<OrpcWs>` still serves as a construct-and-own
   * provider.
   */
  clientContract?: TClientContract;
  /**
   * Rendered until the WS reaches `connected` for the FIRST time on this
   * client instance. The gate then LATCHES: children stay mounted through
   * later disconnect blips / reconnects (a re-engaging fallback would unmount
   * the whole subtree — losing component state, unregistering every
   * `useServerHandler`, and resetting subscriptions — on a 1s heartbeat
   * hiccup). Observe reconnect blips below via `useConnectionState` instead.
   * Omit to always render `children` (even pre-connect).
   */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * The build-once value graph `<OrpcWs>` owns: the constructed client plus the
 * server→client `register` callback (`null` when bidi is off). Both live in the
 * SAME `useLazyRef` box so their identities are stable across renders together.
 */
interface OrpcWsInternals {
  client: OrpcWsClient<AnyContractRouter>;
  register: RegisterServerHandler | null;
  /**
   * Latch for the `fallback` gate: has THIS client instance ever reached
   * `connected`? Lives in the same build-once box as the client so its
   * lifetime is the CLIENT'S, by construction — a fresh client (only possible
   * via a fresh component instance, since `useLazyRef` builds exactly once
   * per mounted instance) gets a fresh `false` latch, and StrictMode's double
   * render/mount reuses the one box, so the latch can't reset spuriously.
   */
  hasConnectedOnce: boolean;
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
 * Snapshot the live registry as the `Record` the core delegating router reads.
 *
 * The registry is a `Map` (clean identity-based delete — see `register` below),
 * but `createDelegatingClientRouter`'s leaves index a plain `Record` by name
 * (`map[name]`). Built with a `null` prototype so a procedure literally named
 * `"__proto__"` lands as an own key (matching the core helper's own guard)
 * rather than hitting the prototype setter. Called only on an actual
 * server→client invocation (rare), so the per-call allocation is negligible.
 */
function registryToRecord(
  registry: Map<string, DelegatingHandler>,
): Record<string, DelegatingHandler> {
  const out: Record<string, DelegatingHandler> = Object.create(null);
  for (const [name, handler] of registry) out[name] = handler;
  return out;
}

/**
 * Construct-and-own ORPC-WS provider. Builds the client from props ONCE,
 * connects on mount / disposes on unmount, and exposes it to descendants via
 * `<OrpcWsProvider>` (the existing hooks work unchanged below it) plus, for
 * bidi, the server→client `register` via `<ServerHandlerContext>`. A
 * `fallback` gates `children` only until the FIRST connect — the gate then
 * latches, so reconnect blips never unmount the subtree (see the `fallback`
 * prop doc).
 *
 * The component takes a SINGLE generic — `TClientContract`, INFERRED from the
 * `clientContract` prop. The consumer's CLIENT→SERVER contract is NOT a generic
 * here: the internally-built client is stored as `OrpcWsClient<AnyContractRouter>`
 * and the c2s contract is asserted at the READ site by `useOrpcWs<MyContract>()`.
 *
 * @example one-way (no bidi)
 *   <OrpcWs url={WS_URL} tokenProvider={tp} fallback={<Spinner />}>
 *     <App />
 *   </OrpcWs>
 *
 * @example bidi (server→client) — pass the contract VALUE; implement in children
 *   <OrpcWs url={WS_URL} clientContract={clientContract}>
 *     <ServerToasts />   // calls useServerHandler("showToast", …) inside
 *     <App />
 *   </OrpcWs>
 */
export function OrpcWs<
  TClientContract extends AnyContractRouter = never,
>(props: OrpcWsProps<TClientContract>): ReactNode {
  const { clientContract, fallback, children, ...constructionOpts } = props;

  // Build the client EXACTLY ONCE via a ref-guard lazy-init (`useLazyRef`), NOT
  // a `useState` initializer: StrictMode + dev DOUBLE-INVOKES `useState`
  // initializers to surface impure ones, which here would build (and orphan) a
  // SECOND whole client graph + delegating router on every dev mount. Captures
  // the FIRST render's construction options + the procedure key set — both are
  // initial-only by contract. With a `clientContract` we own a live registry +
  // a STABLE delegating router (identity never changes → no reconnect on
  // re-render) and expose `register` to descendants; without one we build a
  // plain one-way client. Typed as `OrpcWsClient<AnyContractRouter>` — the c2s
  // contract is erased here and re-asserted at the read site by
  // `useOrpcWs<MyContract>()`.
  const internals = useLazyRef<OrpcWsInternals>(() => {
    if (!clientContract) {
      return {
        client: createOrpcWsClient<AnyContractRouter>({ ...constructionOpts }),
        register: null,
        hasConnectedOnce: false,
      };
    }

    // The router's NAME SET comes from the CONTRACT (static, known now) — NOT
    // from registrations, which arrive later from descendants. The shape is
    // frozen here; only implementations are filled in afterward.
    const names = Object.keys(clientContract);

    // FLAT v1 ONLY: every top-level entry must be a LEAF contract procedure. A
    // NESTED sub-router (`oc.router({ grp: oc.router({...}) })`) would surface
    // `grp` as a name and the delegating router would silently build a broken
    // flat leaf for it — a quiet footgun. Fail loud instead, naming the offending
    // key. (`isContractProcedure` is `@orpc/contract`'s runtime guard — a value
    // import of an already-declared dep, NOT `@orpc/server`.)
    const entries = clientContract as Record<string, unknown>;
    for (const name of names) {
      if (!isContractProcedure(entries[name])) {
        throw new Error(
          `[orpc-ws] <OrpcWs> clientContract entry "${name}" is not a flat ` +
            `contract procedure; nested client contracts are not supported (flat v1).`,
        );
      }
    }

    // Live implementation registry. A `Map` for clean identity-based deletes.
    const registry = new Map<string, DelegatingHandler>();

    // Route the duplicate-name warning through the SAME logger the client is
    // built with (CLAUDE.md "Zero console.log" — never `console`). Resolved
    // once from the first render's options (initial-only by contract).
    const logger: Logger = constructionOpts.logger ?? noopLogger;

    // DUPLICATE-NAME SEMANTICS (a usage error — two mounted components claiming
    // one procedure): LAST-WINS, and the WINNER'S unmount clears the name. The
    // dispose deletes by identity, so an unmounting OLDER registration can't
    // clobber a NEWER one that replaced it; but there is deliberately NO LIFO
    // fallback either — if the WINNER (last registrant) unmounts FIRST while an
    // earlier one is still mounted, the name goes dead (the earlier registration
    // is NOT resurrected). Stacking to restore it would be over-engineering for a
    // misuse case the warning already flags; the behavior is pinned by tests.
    const register: RegisterServerHandler = (name, handler) => {
      if (registry.has(name)) {
        logger.warn(
          `[orpc-ws] useServerHandler: a handler for server→client procedure ` +
            `"${name}" is already registered; overwriting (last registration wins).`,
        );
      }
      registry.set(name, handler);
      return () => {
        // Dispose BY IDENTITY: delete ONLY if THIS wrapper is still current. If
        // a later (duplicate) registration replaced us, an unmounting older
        // registration must NOT clobber the newer one — so guard on identity.
        if (registry.get(name) === handler) registry.delete(name);
      };
    };

    // ONE identity-stable delegating router; leaves read the LIVE registry per
    // call (`registryToRecord` snapshots it into the `Record` the core indexes).
    const delegating = createDelegatingClientRouter(names, () =>
      registryToRecord(registry),
    );

    return {
      client: createOrpcWsClient<AnyContractRouter, typeof delegating>({
        ...constructionOpts,
        clientRouter: delegating,
      }),
      register,
      hasConnectedOnce: false,
    };
  });
  const { client, register } = internals;

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

  // Reactive gate for `fallback` — LATCHED after the FIRST connect. Gating on
  // the live status (`conn.status === "connected"`) would re-engage the
  // fallback on EVERY disconnect: a 1s heartbeat blip would unmount the whole
  // children subtree (state loss, every `useServerHandler` unregistered,
  // subscriptions reset). Instead the fallback shows only until this client
  // instance first reaches `connected`; after that children stay mounted
  // through blips/reconnects (consumers observe those via
  // `useConnectionState`). The render-phase write to the latch is safe: it is
  // idempotent and monotonic (false→true only), and it records an external
  // fact about the client ("has connected at least once") that stays true even
  // if a concurrent render is discarded — so it can never diverge from the
  // committed tree. The latch lives in `internals`, the client's own
  // build-once box, so its lifetime is tied to the client instance (see
  // `OrpcWsInternals.hasConnectedOnce`).
  const conn = useConnectionState(client);
  if (conn.status === "connected") internals.hasConnectedOnce = true;
  const showChildren = internals.hasConnectedOnce || fallback === undefined;

  // `client` is already `OrpcWsClient<AnyContractRouter>` — the exact erased
  // contract type the context stores; `useOrpcWs<MyContract>()` re-asserts the
  // c2s contract at the read site. The `ServerHandlerContext` (inside) carries
  // the server→client `register` for `useServerHandler` descendants — `null`
  // when bidi is off, so a stray `useServerHandler` then throws a clear error.
  return (
    <OrpcWsProvider client={client}>
      <ServerHandlerContext.Provider value={register}>
        {showChildren ? children : fallback}
      </ServerHandlerContext.Provider>
    </OrpcWsProvider>
  );
}

// React adapter — optional `OrpcWsProvider` + `useOrpcWs()` (Phase 2).
//
// Most apps construct ONE `OrpcWsClient` for the whole tree. Threading it
// through props is noise; threading it through React Context is the
// idiomatic answer. This provider is the small ergonomic helper.
//
// Why a separate hook (`useOrpcWs`) instead of returning the client from a
// hook tied to `useConnectionState`: components that only want to dispatch
// RPC calls (`client.rpc.foo.bar(...)`) shouldn't be re-rendered on every
// state transition. Keeping the channels split — `useOrpcWs()` for the
// client object (stable identity, no re-renders), `useConnectionState()`
// for reactive state — mirrors the core's "state vs events" split
// (CLAUDE.md §"State vs events: separate concerns").

import { createContext, useContext, type ReactNode } from "react";

import type { AnyContractRouter } from "@orpc/contract";

import type { OrpcWsClient } from "../index.js";

// Context value is typed as `OrpcWsClient<AnyContractRouter> | null`. The
// `AnyContractRouter` upper bound keeps the context usable for any
// consumer's contract; `useOrpcWs<TContract>()` casts down at the read site.
// `null` is the "no provider in tree" sentinel — `useOrpcWs` throws then.
const OrpcWsContext = createContext<OrpcWsClient<AnyContractRouter> | null>(
  null,
);

export interface OrpcWsProviderProps {
  /**
   * The client to expose to descendants. Construct once (e.g. at the app
   * root) and pass the same reference across renders — context value
   * identity drives `useOrpcWs()` consumer re-render skipping.
   */
  client: OrpcWsClient<AnyContractRouter>;
  children: ReactNode;
}

/**
 * Make an `OrpcWsClient` available to descendant components via
 * `useOrpcWs()`. Optional — consumers who prefer prop-drilling, a global
 * singleton, or a different DI mechanism can skip this provider and call
 * `useConnectionState(client)` directly.
 */
export function OrpcWsProvider({
  client,
  children,
}: OrpcWsProviderProps): ReactNode {
  return (
    <OrpcWsContext.Provider value={client}>{children}</OrpcWsContext.Provider>
  );
}

/**
 * Read the `OrpcWsClient` from context. Throws if called outside of an
 * `<OrpcWsProvider>` — the early throw is deliberate: a silent `null`
 * return would push every consumer into defensive checks, which is the
 * pattern this hook exists to avoid.
 *
 * Typed via a caller-supplied `TContract` so `useOrpcWs<MyContract>().rpc`
 * preserves end-to-end ORPC typing.
 */
export function useOrpcWs<
  TContract extends AnyContractRouter,
>(): OrpcWsClient<TContract> {
  const client = useContext(OrpcWsContext);
  if (!client) {
    throw new Error(
      "useOrpcWs must be used inside <OrpcWsProvider>. Wrap your app (or the relevant subtree) with <OrpcWsProvider client={...}>.",
    );
  }
  // Cast: the context erases `<TContract>` to `AnyContractRouter` at
  // storage time; the consumer re-asserts at read time. Library has no
  // way to verify the assertion — it's the consumer's responsibility to
  // pass the same TContract used at `createOrpcWsClient`.
  return client as OrpcWsClient<TContract>;
}

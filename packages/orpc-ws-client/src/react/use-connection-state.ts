// React adapter — `useConnectionState` hook (Phase 2).
//
// One-liner over `useSyncExternalStore`. Subscribes a React component to a
// client's connection state using the framework-free
// `{ getState, subscribe }` shape the core exposes (CLAUDE.md §"State
// contract").
//
// Bug 7 invariant: the core's `subscribe()` does NOT immediately invoke
// the callback. The initial value comes from `getSnapshot()` (= `getState()`)
// per the `useSyncExternalStore` contract. Under React StrictMode the
// double-mount therefore does not tear: both mounts read the same snapshot,
// and React only re-renders on a real subscription notification.
//
// Reference stability: `ConnectionStateManager.setState` dedupes by
// structural equality (`connectionStatesEqual`) and only replaces the
// internal `state` reference when it actually changes. Successive
// `getState()` calls between transitions return the SAME object, so
// `useSyncExternalStore`'s identity-based bail-out works correctly and
// React never sees a tear caused by the snapshot looking new on every
// render. See `state/__tests__/connection-state.test.ts` for the pinning
// tests of this invariant.
//
// SSR: `getServerSnapshot` is identical to `getSnapshot` — the client is
// the same object on server and client, and a tagged-record state is
// trivially serializable. Most consumers won't SSR a WS client (a server
// has no live connection), but if they do the initial state is honest
// (`disconnected({ willRetry: false })` from the composition root).

import { useSyncExternalStore } from "react";

import type { AnyContractRouter } from "@orpc/contract";

import type { OrpcWsClient } from "../index.js";
import type { ConnectionState } from "../state/types.js";

/**
 * Subscribe to a client's connection state in a React component.
 *
 * @param client - the `OrpcWsClient` returned by `createOrpcWsClient`. Pass
 *   the SAME client instance across renders (typically via context — see
 *   `OrpcWsProvider`) so the subscription identity is stable.
 *
 * @returns the current `ConnectionState`. Re-renders the component whenever
 *   the client transitions to a structurally-different state.
 *
 * @example
 *   const conn = useConnectionState(client);
 *   if (conn.status === "connecting") return <Spinner />;
 *   if (conn.status === "disconnected" && !conn.willRetry) return <Login />;
 */
export function useConnectionState<TContract extends AnyContractRouter>(
  client: OrpcWsClient<TContract>,
): ConnectionState {
  return useSyncExternalStore(
    client.state.subscribe,
    client.state.getState,
    client.state.getState,
  );
}

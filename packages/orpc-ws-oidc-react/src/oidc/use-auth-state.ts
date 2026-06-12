// React adapter — `useAuthState` hook.
//
// One-liner over `useSyncExternalStore`. Subscribes a React component to an
// OIDC auth client's `{ status, user }` snapshot using the framework-free
// `{ getAuthState, subscribe }` seam the core exposes (CLAUDE.md §"State
// contract" — same shape as the WS client's connection state).
//
// Reference stability: the core's `createAuthStore` caches its snapshot and
// only swaps in a new object when `status`/`user` actually change, so
// successive `getAuthState()` calls return the SAME object between
// transitions. That makes `useSyncExternalStore`'s `Object.is` bail-out work
// and avoids the classic "fresh object every render → infinite loop". See the
// core's `auth-store.ts` for the dirty-flag + value-compare implementation.
//
// `client.subscribe` / `client.getAuthState` are bound once at factory time
// (object methods on the value returned by `createOidcAuth`), so their
// identity is stable across renders — no `useCallback` wrapping needed,
// mirroring `useConnectionState`.
//
// SSR: `getServerSnapshot` is identical to `getSnapshot`. The auth client is
// the same object on server and client and the snapshot is trivially
// serializable; on the server it reads `anonymous` (no storage), which is the
// honest pre-hydration value.

import { useSyncExternalStore } from "react";

import type { AuthSnapshot, OidcAuth } from "@orpc-ws/oidc-pkce";

/**
 * Subscribe to an OIDC auth client's `{ status, user }` state in a component.
 *
 * @param client - the `OidcAuth` returned by `createOidcAuth`. Pass the SAME
 *   instance across renders (typically a module-level singleton or context
 *   value) so the subscription identity is stable.
 *
 * @returns the current {@link AuthSnapshot}. Re-renders the component whenever
 *   the auth state transitions (login, logout, refresh, cross-tab change).
 *
 * @example
 *   const { status, user } = useAuthState(authClient);
 *   if (status === "anonymous") return <SignIn />;
 *   return <span>Hello, {user?.name}</span>;
 */
export function useAuthState(client: OidcAuth): AuthSnapshot {
  return useSyncExternalStore(
    client.subscribe,
    client.getAuthState,
    client.getAuthState,
  );
}

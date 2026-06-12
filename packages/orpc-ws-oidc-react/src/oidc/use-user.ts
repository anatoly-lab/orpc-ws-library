// React adapter — `useUser` hook.
//
// Convenience selector over `useAuthState`. Returns just the authenticated
// subject (or `null`), for the common "show the user's name / gate on
// presence" case where the component doesn't care about the coarse status.
//
// Referential stability: we return `snapshot.user` directly — the SAME object
// identity the core's cached snapshot holds. We do NOT wrap it in a new object
// or re-derive it, so a component that depends on `user` identity (memo deps,
// effect deps) only sees a change when the user actually changes. (The core
// already guarantees `user` identity is stable between real changes via its
// field-wise value compare in `auth-store.ts`.)
//
// Deriving from `useAuthState` rather than a second `useSyncExternalStore`
// with a selector keeps a single subscription path and avoids the selector
// having to re-implement snapshot caching — the snapshot is already stable, so
// reading one field off it is free of the "selector returns fresh value"
// foot-gun.

import type { OidcAuth, OidcUser } from "@orpc-ws/oidc-pkce";

import { useAuthState } from "./use-auth-state.js";

/**
 * Subscribe to just the authenticated subject.
 *
 * @param client - the `OidcAuth` from `createOidcAuth` (same-instance caveat
 *   as {@link useAuthState}).
 * @returns the current user, or `null` when anonymous. Re-renders only when
 *   the user identity changes.
 */
export function useUser(client: OidcAuth): OidcUser | null {
  return useAuthState(client).user;
}

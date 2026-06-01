// Test double of the OIDC auth client's PUBLIC observable seam.
//
// We exercise the hooks against the seam they actually use —
// `getAuthState` + `subscribe` — NOT against real `createOidcAuth` and NOT
// against core internals. This keeps the hook tests honest (they test the
// adapter, not the core) and deterministic (no storage, no discovery, no
// fetch). Mirrors the style of `ws/__tests__/fake-client.ts` for the WS hooks.
//
// The double reimplements the core's stable-snapshot contract in miniature:
// `getAuthState()` returns a referentially-stable object until `set()` changes
// it. That's the property the hooks depend on, so the double must honor it or
// the tests would pass for the wrong reasons.

import type { AuthSnapshot, OidcAuth, OidcUser } from "@repo/oidc-pkce";

export interface FakeAuth {
  /** The seam the hooks consume — `Pick`'d so the double stays tiny. */
  client: Pick<OidcAuth, "getAuthState" | "subscribe">;
  /** Test-only: change the snapshot and notify subscribers (one emit). */
  set(next: AuthSnapshot): void;
  /** Test-only: notify subscribers WITHOUT changing the snapshot (no-op emit). */
  emit(): void;
  /** Current live subscriber count — asserts unsubscribe-on-unmount. */
  listenerCount(): number;
}

export function makeFakeAuth(initial: AuthSnapshot): FakeAuth {
  let snapshot = initial;
  const listeners = new Set<() => void>();

  // Bound-once stable references, exactly like the real factory returns, so
  // useSyncExternalStore sees a stable `subscribe`/`getSnapshot` identity.
  const getAuthState = (): AuthSnapshot => snapshot;
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const notify = (): void => {
    listeners.forEach((l) => l());
  };

  return {
    client: { getAuthState, subscribe },
    set(next: AuthSnapshot): void {
      snapshot = next;
      notify();
    },
    emit(): void {
      // Snapshot identity unchanged — useSyncExternalStore must NOT re-render.
      notify();
    },
    listenerCount(): number {
      return listeners.size;
    },
  };
}

/** Tiny helper to build a snapshot without spelling out the full user shape. */
export function authed(user: OidcUser): AuthSnapshot {
  return { status: "authenticated", user };
}

export const ANON: AuthSnapshot = { status: "anonymous", user: null };

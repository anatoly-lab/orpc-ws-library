// Observable auth-state store.
//
// The PUSH half of the auth seam. `client.ts`'s `getAuthStatus()` /
// `getUser()` are PULL-only synchronous reads; this module adds the
// notification channel a reactive UI needs (React's `useSyncExternalStore`,
// Svelte stores, Vue's `customRef`) without touching the pull API.
//
// Implements the `{ getState(): T; subscribe(cb: () => void): () => void }`
// shape from CLAUDE.md §"State contract" — the SAME shape the ws-client's
// `ConnectionStateManager` exposes. We mirror its idioms deliberately:
// `subscribe()` never fires the callback immediately (initial value comes
// from `getSnapshot`), and a listener that throws is isolated from siblings.
//
// One concept per file (CLAUDE.md "No god files"): this owns ONLY the
// observer set + snapshot cache + cross-tab wiring. The composition root
// (`client.ts`) computes status/user and decides whether cross-tab applies.

import type { AuthStatus, OidcUser } from "./types.js";

/**
 * Synchronous, referentially-stable snapshot of auth state.
 *
 * Returned by `getAuthState()`. The object identity is stable across calls
 * while nothing changes (see {@link createAuthStore}) — load-bearing for
 * `useSyncExternalStore`, which compares snapshots with `Object.is` and will
 * infinite-loop if a fresh object is handed back on every render.
 */
export interface AuthSnapshot {
  status: AuthStatus;
  /**
   * The authenticated subject, or `null` when anonymous. Identity is stable
   * between real changes (same caveat as the enclosing snapshot). Note the
   * `expired` status still carries a `user` parsed from the stale id-token —
   * the UI may show "session expired, <name>" rather than a bare prompt.
   */
  user: OidcUser | null;
}

/** Collaborators the store reads through. Injected by the composition root. */
export interface AuthStoreDeps {
  /** Current coarse-grained status. Reuses `OidcAuth.getAuthStatus()`. */
  getStatus(): AuthStatus;
  /** Current user, or `null`. Reuses `OidcAuth.getUser()`. */
  getUser(): OidcUser | null;
  /**
   * The localStorage key whose cross-tab 'storage' events should trigger a
   * notification, or `null` to disable cross-tab wiring entirely.
   *
   * `null` is the correct value whenever the auth client was given a custom
   * `Storage` (in-memory, IndexedDB, etc.): the browser's window 'storage'
   * event ONLY fires for the global `localStorage`/`sessionStorage`, so a
   * custom store would never produce events — and reacting to some unrelated
   * key's events would be wrong. Cross-tab sync is therefore a feature of the
   * DEFAULT localStorage-backed Storage only; documented limitation.
   */
  storageKey: string | null;
}

/** The observable seam composed into `OidcAuth`. */
export interface AuthStore {
  getAuthState(): AuthSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Mark the snapshot stale and notify listeners. Called by the composition
   * root after any token mutation (callback write, logout, clear, refresh).
   * Deliberately cheap: the actual recompute is deferred to the next
   * `getAuthState()` read so a burst of mutations collapses into one rebuild.
   */
  emit(): void;
}

/** Field-wise user equality. `parseIdToken` returns a FRESH object on every
 * call, so identity comparison would always report "changed" and churn the
 * snapshot. Compare by value over the four surfaced claims. */
function usersEqual(a: OidcUser | null, b: OidcUser | null): boolean {
  if (a === b) return true; // covers the both-null case
  if (a === null || b === null) return false;
  return (
    a.sub === b.sub &&
    a.email === b.email &&
    a.name === b.name &&
    a.preferredUsername === b.preferredUsername
  );
}

/**
 * Build the observable auth store.
 *
 * Snapshot stability strategy — dirty-flag + lazy rebuild-on-read:
 *   - `emit()` only flips `dirty = true` and notifies; it does NOT recompute.
 *   - `getAuthState()` rebuilds the snapshot ONLY when `dirty`, compares the
 *     fresh `{status, user}` to the cached snapshot by VALUE, and swaps in a
 *     new object reference only when something actually differs.
 *
 * Why rebuild on READ rather than in each mutation method: cross-tab 'storage'
 * events fire from OUTSIDE any mutation method, so the read path is the single
 * place that catches every source (local mutation AND cross-tab) uniformly.
 * The result is `getAuthState() === getAuthState()` between real changes — the
 * exact invariant `useSyncExternalStore`'s `Object.is` bail-out depends on.
 */
export function createAuthStore(deps: AuthStoreDeps): AuthStore {
  const listeners = new Set<() => void>();

  // Seeded eagerly so the very first `getAuthState()` is a cache hit and the
  // first React render reads a stable object without a rebuild.
  let cached: AuthSnapshot = { status: deps.getStatus(), user: deps.getUser() };
  let dirty = false;

  // Lazily-added cross-tab listener. We attach to `window` only while at least
  // one subscriber is observing and tear it down when the last leaves — so the
  // library never leaks a global listener when nobody's watching (matters for
  // short-lived auth instances and SSR/test teardown). `null` while detached.
  let onStorage: ((e: StorageEvent) => void) | null = null;

  const crossTabEnabled =
    deps.storageKey !== null && typeof window !== "undefined";

  function rebuildIfDirty(): void {
    if (!dirty) return;
    dirty = false;
    const nextStatus = deps.getStatus();
    const nextUser = deps.getUser();
    // Value-compare; only allocate a new snapshot object when something
    // actually changed, preserving referential stability for unchanged reads.
    if (nextStatus === cached.status && usersEqual(nextUser, cached.user)) {
      return;
    }
    cached = { status: nextStatus, user: nextUser };
  }

  function notify(): void {
    listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // A misbehaving listener must not break siblings. The core never
        // writes to the console (CLAUDE.md "Zero `console.log`"); the auth
        // store has no injected logger, so we swallow. Listeners here are
        // framework adapters (useSyncExternalStore's internal callback) that
        // do not throw in practice.
      }
    });
  }

  function addWindowListener(): void {
    if (!crossTabEnabled || onStorage !== null) return;
    onStorage = (e: StorageEvent): void => {
      // Only the auth client's own key matters. `e.key` is `null` when the
      // whole store is cleared (`localStorage.clear()`) — treat that as a
      // change too, since our key may have been wiped.
      if (e.key !== null && e.key !== deps.storageKey) return;
      emit();
    };
    window.addEventListener("storage", onStorage);
  }

  function removeWindowListener(): void {
    if (onStorage === null) return;
    window.removeEventListener("storage", onStorage);
    onStorage = null;
  }

  function emit(): void {
    dirty = true;
    notify();
  }

  return {
    getAuthState(): AuthSnapshot {
      rebuildIfDirty();
      return cached;
    },

    subscribe(listener: () => void): () => void {
      // Lazily wire the cross-tab listener on the FIRST subscriber. No
      // immediate callback (mirrors ConnectionStateManager / Bug 7): the
      // initial value comes from getAuthState(), not from a subscribe-time
      // fire, so React StrictMode's double-mount doesn't double-read.
      if (listeners.size === 0) addWindowListener();
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
        // Tear down the global listener once nobody's observing.
        if (listeners.size === 0) removeWindowListener();
      };
    },

    emit,
  };
}

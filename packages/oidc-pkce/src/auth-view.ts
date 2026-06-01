// Storage → auth-view projection.
//
// Pure read-side helpers that turn the persisted `Tokens` blob into the
// coarse `{ status, user }` view the rest of the library exposes. Split out of
// `client.ts` (which was bumping the ~300 LOC ceiling) because this is a
// distinct concern: the composition root WIRES collaborators, this module
// PROJECTS storage into view-state. One concept per file (CLAUDE.md "No god
// files").
//
// Both the public pull methods (`getAuthStatus`/`getUser`) and the observable
// store (auth-store.ts, via injected `getStatus`/`getUser`) read through these,
// so the "is it expired?" / "decode the id_token" decisions live in exactly
// one place.

import { isTokenExpired, parseIdToken } from "./tokens.js";
import type { AuthStatus, OidcUser, Storage } from "./types.js";

/** Read-side projection of `Storage` into the coarse auth view. */
export interface AuthView {
  /** `anonymous` | `expired` | `authenticated`, derived from stored tokens. */
  readStatus(): AuthStatus;
  /**
   * The decoded subject, or `null`. REFERENTIALLY STABLE while the underlying
   * id_token is unchanged (see below) — the snapshot-stability contract that
   * `useSyncExternalStore` depends on.
   */
  readUser(): OidcUser | null;
}

/**
 * Build the read-side projection over a single `Storage` handle.
 *
 * `readUser()` memoizes the decoded user keyed by the raw id_token string:
 * `parseIdToken` allocates a fresh object every call, so without this a
 * reactive consumer that compares `user` by identity would see a "change" on
 * every read — defeating `useSyncExternalStore`'s `Object.is` bail-out and
 * causing spurious re-renders (pathological under cross-tab storage-event
 * churn). We re-decode ONLY when the token rotates (refresh) or clears
 * (logout). A malformed token decodes to `null`, cached against the bad token
 * so a broken session doesn't re-decode on every call.
 */
export function createAuthView(storage: Storage): AuthView {
  let cachedIdToken: string | null = null;
  let cachedUser: OidcUser | null = null;

  return {
    readStatus(): AuthStatus {
      const t = storage.read();
      if (!t) return "anonymous";
      return isTokenExpired(t) ? "expired" : "authenticated";
    },
    readUser(): OidcUser | null {
      const t = storage.read();
      if (!t) {
        // No tokens (logout / never-logged-in). Reset the cache so a later
        // login re-decodes from scratch.
        cachedIdToken = null;
        cachedUser = null;
        return null;
      }
      // Same id_token → return the SAME object reference (stability contract).
      if (t.idToken === cachedIdToken) return cachedUser;
      cachedIdToken = t.idToken;
      cachedUser = parseIdToken(t.idToken);
      return cachedUser;
    },
  };
}

// A custom `TokenProvider` for the backend-token auth mode.
//
// The SaaS-style split: the SERVER holds the long-lived refresh token (in the
// httpOnly `sid` session cookie set on /auth/callback); the BROWSER holds only
// a short-lived access token, in memory, which it passes to the WS via
// `?token=`. This provider is the binding between the library's auth seam and
// the server's token endpoints.
//
// It implements `@orpc-ws/client`'s `TokenProvider` contract exactly:
//
//   - `getToken()` is a SYNCHRONOUS read of the currently-cached access token.
//     No fetch, no refresh — the library decides when to refresh.
//   - `refresh()` is the ONLY async path. It POSTs /auth/refresh (cookie-authed)
//     and returns the fresh token, or `null` on failure. It MUST be pure: no
//     redirect, no UI-state clear, no WS calls. When `refresh()` yields null the
//     library closes the WS and fires `onTerminalAuthFailure` itself — wiring
//     cleanup in here would re-enter the library's teardown (the foot-gun the
//     library design explicitly avoids; see CLAUDE.md "Auth flow contract").
//
// `bootstrap()` is an app-level extra (NOT part of the library seam): it pulls
// the FIRST access token after login via POST /auth/token (cookie-authed),
// returning whether a server session exists. AppLayout calls it on mount before
// connecting the WS.

import type { TokenProvider } from "@orpc-ws/client";

/** Server response shape for both /auth/token and /auth/refresh. */
interface TokenResponse {
  accessToken: string;
  expiresIn: number;
}

function isTokenResponse(value: unknown): value is TokenResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).accessToken === "string"
  );
}

/**
 * The provider exposes the library seam (`getToken` / `refresh`) plus the
 * app-only `bootstrap()`. AppLayout needs `bootstrap`, so we widen the public
 * type rather than hand back a bare `TokenProvider`.
 */
export interface BackendTokenProvider extends TokenProvider {
  /**
   * Pull the first access token after login (cookie-authed POST /auth/token).
   * Resolves `true` if a server session exists (token cached), `false` if not
   * (no `sid` cookie / 401). App-level only — the library never calls this.
   */
  bootstrap(): Promise<boolean>;
}

export function createBackendTokenProvider(
  serverOrigin: string,
): BackendTokenProvider {
  // The single piece of mutable state: the latest access token, in memory.
  // Lost on reload — that is intentional; `bootstrap()` re-pulls it from the
  // server session on the next page load.
  let accessToken: string | null = null;

  // Shared POST for /auth/token and /auth/refresh: both are cookie-authed
  // (credentials:"include") and both return `{ accessToken, expiresIn }`.
  // Returns the new token on success, `null` on any failure (non-2xx, network
  // error, malformed body). The caller decides what null means.
  async function postForToken(path: string): Promise<string | null> {
    try {
      const res = await fetch(`${serverOrigin}${path}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      if (!isTokenResponse(body)) return null;
      accessToken = body.accessToken;
      return accessToken;
    } catch {
      // Pure failure path — no side effects beyond returning null.
      return null;
    }
  }

  return {
    // Synchronous read of the cached token. The library calls this to build the
    // WS `?token=` query param; null means "no token" (URL carries none).
    getToken(): string | null {
      return accessToken;
    },

    // Pure refresh: cookie-authed POST /auth/refresh → new access token or null.
    // No redirect, no state-clear, no WS calls (see file header). On null the
    // library handles teardown via `onTerminalAuthFailure`.
    async refresh(): Promise<string | null> {
      return postForToken("/auth/refresh");
    },

    // App-only first-token pull. `true` = session exists and token cached.
    async bootstrap(): Promise<boolean> {
      const token = await postForToken("/auth/token");
      return token !== null;
    },
  };
}

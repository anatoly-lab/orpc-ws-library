// Tiny client-side auth glue for the backend-token mode.
//
// Unlike the PKCE demo (which leans on `@orpc-ws/oidc-pkce`'s reactive auth
// store), this app deliberately imports NO oidc package — the whole point of
// this demo is the WS-only consumer path. So the "am I signed in?" answer is
// derived here from the server session, not from a library store:
//
//   - `bootstrap()` delegates to the provider's `/auth/token` pull and reports
//     whether a server session exists. AppLayout calls it once on mount.
//   - `login()` navigates to the server's /auth/login, which 302s to Keycloak
//     and (after /auth/callback) sets the `sid` cookie + 302s back to "/".
//   - `logout()` POSTs /auth/logout (cookie-authed) to clear the server session,
//     then navigates to the IdP end-session URL the server returns.
//
// There is no reactive store here on purpose: the session lifecycle is
// page-navigation driven (login/logout both leave the SPA via redirect), so a
// one-shot `bootstrap()` on mount is all AppLayout needs.

import { config } from "./config.js";
import { tokenProvider } from "./ws-client.js";

interface LogoutResponse {
  // The IdP end-session URL, or `null` when the server couldn't reach IdP
  // discovery (the session is already destroyed server-side regardless).
  endSessionUrl: string | null;
}

function isLogoutResponse(value: unknown): value is LogoutResponse {
  if (typeof value !== "object" || value === null) return false;
  const url = (value as Record<string, unknown>).endSessionUrl;
  return typeof url === "string" || url === null;
}

/**
 * Pull the first access token from the server session. Returns whether a
 * session exists (true → AppLayout connects the WS; false → render <SignIn />).
 * Delegates to the provider so the cached token is populated as a side effect.
 */
export async function bootstrap(): Promise<boolean> {
  return tokenProvider.bootstrap();
}

/**
 * Start the login flow. Full-page navigation to the server's /auth/login, which
 * redirects to Keycloak. The server owns the entire OIDC dance and the refresh
 * token; the browser never sees it.
 */
export function login(): void {
  window.location.href = `${config.SERVER_ORIGIN}/auth/login`;
}

/**
 * End the session. Clears the server session first (so the refresh token is
 * revoked server-side); on success, the server's `endSessionUrl` decides where
 * we land:
 *   - non-empty string → navigate to the IdP end-session URL (RP-initiated
 *     logout, clears the IdP's own SSO cookie).
 *   - null / absent     → IdP discovery was unreachable, but the server session
 *     is ALREADY destroyed, so just reload the SPA root and let AppLayout land
 *     on the signed-out <SignIn /> screen. We must NOT bounce back through
 *     /auth/login here — the user just asked to sign out.
 * Only a failed POST (network error / non-2xx) falls back to /auth/login.
 */
export async function logout(): Promise<void> {
  try {
    const res = await fetch(`${config.SERVER_ORIGIN}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) {
      const body: unknown = await res.json();
      const endSessionUrl = isLogoutResponse(body) ? body.endSessionUrl : null;
      // Non-empty end-session URL → IdP logout; otherwise the session is
      // already gone server-side, so land on the signed-out SPA root.
      window.location.href = endSessionUrl ?? "/";
      return;
    }
  } catch {
    // fall through to the local-login fallback below
  }
  // Fallback: the logout POST itself failed (network error / non-2xx). Send the
  // user back through login rather than leaving them on a stale screen.
  window.location.href = `${config.SERVER_ORIGIN}/auth/login`;
}

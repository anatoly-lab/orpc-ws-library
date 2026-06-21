// Tiny client-side auth glue for the cookie-BFF mode.
//
// The browser holds NO token — the httpOnly `sid` cookie is the only credential
// and it is invisible to JS. So "am I signed in?" is answered by asking the
// server: GET /auth/me (cookie-authed) returns the identity, or 401 if no
// session. This app imports no oidc package — that is the point of the demo.
//
//   - `me()` reads the current identity from the server session (or null).
//   - `login()` navigates to the server's /auth/login, which 302s to Keycloak
//     and (after /auth/callback) sets the `sid` cookie + 302s back to "/".
//   - `logout()` POSTs /auth/logout (cookie-authed) to clear the server session,
//     then navigates to the IdP end-session URL the server returns.

import { config } from "./config.js";

/** Identity returned by GET /auth/me. */
export interface Identity {
  sub: string;
  email?: string;
  name?: string;
}

function isIdentity(value: unknown): value is Identity {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).sub === "string"
  );
}

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
 * Read the current identity from the server session. Returns the identity if a
 * session exists (AppLayout then connects the WS), or `null` on 401 / failure
 * (AppLayout renders <SignIn />).
 */
export async function me(): Promise<Identity | null> {
  try {
    const res = await fetch(`${config.SERVER_ORIGIN}/auth/me`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isIdentity(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Start the login flow. Full-page navigation to the server's /auth/login, which
 * redirects to Keycloak. The server owns the entire OIDC dance and the session;
 * the browser only ever receives the httpOnly `sid` cookie.
 */
export function login(): void {
  window.location.href = `${config.SERVER_ORIGIN}/auth/login`;
}

/**
 * End the session. Clears the server session first; on success, the server's
 * `endSessionUrl` decides where we land:
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
  window.location.href = `${config.SERVER_ORIGIN}/auth/login`;
}

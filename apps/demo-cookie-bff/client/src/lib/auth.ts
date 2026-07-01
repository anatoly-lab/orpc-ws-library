// Client-side auth glue for the cookie-BFF mode (Decision #23: ONE file).
//
// The protocol glue — the typed /auth/me fetch, the in-memory synchronizer-CSRF
// token, the CSRF-aware mutate() wrapper, and the navigation-free logout — now
// lives in the framework-free `@orpc-ws/cookie-bff-client` package. This file
// keeps ONLY the app's NAVIGATION POLICY (where `window.location` goes), which
// is intentionally NOT in the library.
//
// Separation of concerns to note: this `authClient` is the HTTP `/auth/*`
// control plane. The WS client is created SEPARATELY by the <OrpcWs> wrapper in
// AppLayout with NO `tokenProvider` — the httpOnly `sid` cookie rides the WS
// upgrade automatically. The two are independent.

import { createCookieBffAuthClient } from "@orpc-ws/cookie-bff-client";

import { config } from "./config.js";

/**
 * The app's ENRICHED user shape (returned by the server's `resolveUser`,
 * Decision #22). Stays in the app — the library can't know it; it just returns
 * `body.user as TUser`.
 */
export interface Identity {
  sub: string;
  email?: string;
  name?: string;
  /** Enriched field added server-side (proves "enriched user in session"). */
  role?: string;
}

const authClient = createCookieBffAuthClient<Identity>({
  serverOrigin: config.SERVER_ORIGIN,
  loginPath: "/auth/login",
  logoutPath: "/auth/logout",
  mePath: "/auth/me",
});

/**
 * Read the current identity from the server session (or `null`). Delegates to
 * the library, which also refreshes the in-memory CSRF token as a side effect
 * so a later `logout()` can echo it. AppLayout imports this.
 */
export function me(): Promise<Identity | null> {
  return authClient.me();
}

/**
 * Start the login flow — APP navigation policy. The library only builds the
 * URL; deciding to navigate the browser there is the app's call.
 */
export function login(): void {
  window.location.href = authClient.loginUrl();
}

/**
 * End the session, then navigate — APP navigation policy. The library POSTs
 * logout (CSRF header auto-attached) and RETURNS where to go; this app decides:
 *   - non-empty `endSessionUrl` → IdP RP-initiated logout;
 *   - null → the session is already gone server-side, so land on the SPA root.
 * A thrown/failed logout falls back to /auth/login.
 */
export async function logout(): Promise<void> {
  try {
    const { endSessionUrl } = await authClient.logout();
    window.location.href = endSessionUrl ?? "/";
    return;
  } catch {
    // Belt-and-suspenders: `authClient.logout()` resolves `{endSessionUrl:null}`
    // rather than throwing, so this path is unreachable today — kept as a
    // defensive fallback should that contract ever change.
    window.location.href = authClient.loginUrl();
  }
}

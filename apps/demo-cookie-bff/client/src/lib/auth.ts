// Tiny client-side auth glue for the cookie-BFF mode (Decision #23: ONE file).
//
// The browser holds NO token — the httpOnly `sid` cookie is the only credential
// and it is invisible to JS. So "am I signed in?" is answered by asking the
// server: GET /auth/me (cookie-authed) returns the ENRICHED user, or 401 if no
// session. This app imports no oidc package — that is the point of the demo.
//
// CSRF (synchronizer-token pattern): /auth/me returns the session's CSRF token
// in its BODY. We keep it in an IN-MEMORY module variable — NOT localStorage,
// NOT a cookie — so a sibling subdomain's JS can't read it (per-origin memory
// isolation). A page reload re-fetches it via me() on mount. Every mutating
// API call goes through the single `mutate()` wrapper, which auto-attaches the
// `X-CSRF-Token` header + `credentials:"include"` — the header is NOT sprinkled
// across call sites.
//
//   - `me()` reads the current identity (or null) and refreshes the in-memory token.
//   - `login()` navigates to /auth/login → Keycloak → /auth/callback sets `sid` → "/".
//   - `logout()` goes through `mutate()` (CSRF header auto-attached), then navigates.

import { config } from "./config.js";

/** Identity returned (wrapped as `{ user }`) by GET /auth/me. */
export interface Identity {
  sub: string;
  email?: string;
  name?: string;
  /** Enriched field added by the server's `resolveUser` (Decision #22). */
  role?: string;
}

/** GET /auth/me body: the library wraps the enriched user + the CSRF token. */
interface MeResponse {
  user: Identity;
  csrfToken: string;
}

function isMeResponse(value: unknown): value is MeResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const user = v.user;
  return (
    typeof user === "object" &&
    user !== null &&
    typeof (user as Record<string, unknown>).sub === "string" &&
    typeof v.csrfToken === "string"
  );
}

interface LogoutResponse {
  endSessionUrl: string | null;
}

function isLogoutResponse(value: unknown): value is LogoutResponse {
  if (typeof value !== "object" || value === null) return false;
  const url = (value as Record<string, unknown>).endSessionUrl;
  return typeof url === "string" || url === null;
}

// ── In-memory CSRF token (synchronizer-token) ──
// Held only in JS memory, per-origin isolated. Lost on reload — me() refills it.
let csrfToken: string | null = null;

/**
 * The single mutating-API wrapper. Auto-attaches `credentials:"include"` (the
 * `sid` cookie) AND the `X-CSRF-Token` header from the in-memory token. EVERY
 * mutating call (logout, any future authed POST) goes through here so the CSRF
 * header is wired in ONE place, never sprinkled across callers.
 */
function mutate(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  return fetch(`${config.SERVER_ORIGIN}${path}`, {
    method: "POST",
    ...init,
    credentials: "include",
    headers,
  });
}

/**
 * Read the current identity from the server session. Returns the identity if a
 * session exists (AppLayout then connects the WS), or `null` on 401 / failure
 * (AppLayout renders <SignIn />). Refreshes the in-memory CSRF token as a side
 * effect, so a subsequent `logout()` can echo it.
 */
export async function me(): Promise<Identity | null> {
  try {
    const res = await fetch(`${config.SERVER_ORIGIN}/auth/me`, {
      credentials: "include",
    });
    if (!res.ok) {
      csrfToken = null;
      return null;
    }
    const body: unknown = await res.json();
    if (!isMeResponse(body)) return null;
    csrfToken = body.csrfToken; // hold in memory for mutate()
    return body.user;
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
 * End the session. The POST goes through `mutate()` so the `X-CSRF-Token`
 * header (synchronizer-token) is auto-attached. On success, the server's
 * `endSessionUrl` decides where we land:
 *   - non-empty string → navigate to the IdP end-session URL (RP-initiated logout).
 *   - null / absent     → the server session is ALREADY destroyed, so land on
 *     the signed-out SPA root. We must NOT bounce back through /auth/login.
 * Only a failed POST (network error / non-2xx, incl. a 403 if me() never ran)
 * falls back to /auth/login.
 */
export async function logout(): Promise<void> {
  try {
    const res = await mutate("/auth/logout");
    if (res.ok) {
      const body: unknown = await res.json();
      const endSessionUrl = isLogoutResponse(body) ? body.endSessionUrl : null;
      window.location.href = endSessionUrl ?? "/";
      return;
    }
  } catch {
    // fall through to the local-login fallback below
  }
  window.location.href = `${config.SERVER_ORIGIN}/auth/login`;
}

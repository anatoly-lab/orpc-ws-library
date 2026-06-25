// The cookie-BFF /auth/* browser client (synchronizer-token CSRF).
//
// `createCookieBffAuthClient` returns a small object over a closure that holds
// the CSRF token IN MEMORY. Nothing here touches `window` — the consumer owns
// navigation (login redirect, post-logout landing). `fetch` is injectable for
// tests (the same seam shape the server core uses).

/** The `/auth/me` response envelope the server returns. */
interface MeEnvelope {
  /** The enriched app user. Opaque to this package — cast to the consumer's TUser. */
  user: unknown;
  /** The session's synchronizer-CSRF token (§J / Decision #9). */
  csrfToken: string;
}

/** Validate ONLY the envelope: `user` is a non-null object, `csrfToken` a string. */
function isMeEnvelope(value: unknown): value is MeEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.user === "object" &&
    v.user !== null &&
    typeof v.csrfToken === "string"
  );
}

/** The `/auth/logout` response: where the SPA should navigate (app decides). */
interface LogoutEnvelope {
  endSessionUrl: string | null;
}

function isLogoutEnvelope(value: unknown): value is LogoutEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const url = (value as Record<string, unknown>).endSessionUrl;
  return typeof url === "string" || url === null;
}

/** What `logout()` resolves to — the app uses this to decide navigation. */
export interface LogoutResult {
  /** IdP RP-initiated end-session URL, or `null` (no IdP discovery / not advertised). */
  endSessionUrl: string | null;
}

/**
 * Options for {@link createCookieBffAuthClient}.
 *
 * The three endpoint paths are EXPLICIT and REQUIRED — there is no hidden
 * `/auth/*` convention. This decouples the client from the server's path
 * layout: the SPA never assumes the server mounts auth under `/auth`, and there
 * is no "client basePath must match the server prefix" coupling. The client
 * never calls `/callback` (that's a server-only redirect target), so there is
 * no `callbackPath`.
 */
export interface CookieBffAuthClientOptions {
  /** Origin of the API, e.g. `https://api.example.com`. Also the base for `mutate()`. */
  serverOrigin: string;
  /** Path of the login endpoint, e.g. `"/auth/login"`. */
  loginPath: string;
  /** Path of the logout endpoint, e.g. `"/auth/logout"`. */
  logoutPath: string;
  /** Path of the identity endpoint, e.g. `"/auth/me"`. */
  mePath: string;
  /**
   * `fetch` override (a seam for tests / a consumer's instrumented fetch).
   * Defaults to the global `fetch`.
   */
  fetch?: typeof fetch;
}

/** The cookie-BFF auth control-plane client. */
export interface CookieBffAuthClient<TUser> {
  /**
   * `GET {serverOrigin}{mePath}`. Returns the enriched user on a live session,
   * or `null` on 401 / failure. As a side effect, holds the returned CSRF
   * token in memory (for `mutate`); clears the held token on a 401.
   */
  me(): Promise<TUser | null>;
  /**
   * Mutating fetch (POST by default). Auto-attaches `credentials: "include"`
   * (the `sid` cookie) and, when a CSRF token is held, the `X-CSRF-Token`
   * header. This is the ONE place the CSRF header is set.
   *
   * `path` is ORIGIN-relative: it is appended straight to `serverOrigin`
   * (e.g. `"/auth/logout"`, `"/api/things"`). `me`/`logout`/`loginUrl` use
   * their configured paths; `mutate` is the escape hatch for arbitrary authed
   * POSTs that may live anywhere under the origin, so the caller passes the
   * full origin-relative path.
   */
  mutate(path: string, init?: RequestInit): Promise<Response>;
  /**
   * `POST {serverOrigin}{logoutPath}` via `mutate` (so the CSRF header
   * auto-attaches). Returns the server's `endSessionUrl`. Does NOT navigate —
   * the app decides where to go.
   */
  logout(): Promise<LogoutResult>;
  /** Pure string: `{serverOrigin}{loginPath}`. No navigation. */
  loginUrl(): string;
  /** The in-memory CSRF token, or `null` if none held yet (tests/advanced). */
  getCsrfToken(): string | null;
}

const CSRF_HEADER = "X-CSRF-Token";

/** Normalize a configured path so a missing leading slash doesn't break the URL. */
function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Build a cookie-BFF auth client. The CSRF token lives in this closure's
 * `csrfToken` variable — in JS memory only, per-origin isolated (NOT
 * localStorage, NOT a cookie). A page reload loses it; `me()` refills it.
 */
export function createCookieBffAuthClient<TUser>(
  opts: CookieBffAuthClientOptions,
): CookieBffAuthClient<TUser> {
  const fetchImpl = opts.fetch ?? fetch;
  // Trim a trailing slash off serverOrigin and leading-slash-normalize each
  // explicit path so the joins are clean regardless of how the consumer wrote them.
  const origin = opts.serverOrigin.replace(/\/+$/, "");
  const loginPath = normalizePath(opts.loginPath);
  const logoutPath = normalizePath(opts.logoutPath);
  const mePath = normalizePath(opts.mePath);

  // In-memory synchronizer-CSRF token. Closure-scoped on purpose.
  let csrfToken: string | null = null;

  async function me(): Promise<TUser | null> {
    let res: Response;
    try {
      res = await fetchImpl(`${origin}${mePath}`, {
        credentials: "include",
      });
    } catch {
      return null;
    }
    if (res.status === 401) {
      csrfToken = null; // session gone — drop the stale token
      return null;
    }
    if (!res.ok) return null;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    if (!isMeEnvelope(body)) return null;
    csrfToken = body.csrfToken; // hold in memory for mutate()
    return body.user as TUser;
  }

  function mutate(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (csrfToken !== null) headers.set(CSRF_HEADER, csrfToken);
    return fetchImpl(`${origin}${path}`, {
      method: "POST",
      ...init,
      credentials: "include",
      headers,
    });
  }

  async function logout(): Promise<LogoutResult> {
    const res = await mutate(logoutPath);
    if (!res.ok) return { endSessionUrl: null };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { endSessionUrl: null };
    }
    return {
      endSessionUrl: isLogoutEnvelope(body) ? body.endSessionUrl : null,
    };
  }

  function loginUrl(): string {
    return `${origin}${loginPath}`;
  }

  function getCsrfToken(): string | null {
    return csrfToken;
  }

  return { me, mutate, logout, loginUrl, getCsrfToken };
}

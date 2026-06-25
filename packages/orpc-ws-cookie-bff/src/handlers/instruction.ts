// Transport-agnostic `/auth/*` handler I/O (§C.1, §D.4).
//
// The core's handlers never touch express / Nest / Fastify. Each takes an
// `AuthRequest` (the minimal slice of an HTTP request it reads) and returns an
// `AuthInstruction` (what the adapter should DO: set/clear cookies, redirect,
// send a body). An adapter is then a pure translator — that seam is what lets
// a future Fastify/Express adapter reuse 100% of the auth logic.

/** The minimal request slice the handlers read. */
export interface AuthRequest {
  /** Raw `Cookie:` header value, if any. */
  cookieHeader?: string;
  /** Parsed query params (`code`, `state`, …). */
  query?: Record<string, string | undefined>;
  /**
   * Request headers the handlers need beyond cookies — notably the CSRF echo
   * header on logout. Keys are lower-cased by convention.
   */
  headers?: Record<string, string | undefined>;
}

/** One cookie to set, with its full hardened attribute set already applied. */
export interface CookieSpec {
  /** The pre-serialized `Set-Cookie` header value. */
  value: string;
}

/** What the adapter applies to the HTTP response. */
export interface AuthInstruction {
  /** HTTP status code (e.g. 302 redirect, 200, 400, 401). */
  status: number;
  /** `Location` for a redirect, if any. */
  redirect?: string;
  /** Cookies to set (each a ready `Set-Cookie` value). */
  setCookies?: CookieSpec[];
  /** Names of cookies to clear (the handler emits the clearing `Set-Cookie`). */
  setClearCookies?: CookieSpec[];
  /** JSON body to send, if any. */
  body?: unknown;
}

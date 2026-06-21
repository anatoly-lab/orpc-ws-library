// Tiny hand-rolled cookie parse/serialize helpers.
//
// No `cookie` / `cookie-parser` dependency: the backend demos need exactly
// two operations — read one named cookie off a request `Cookie:` header,
// and serialize one `Set-Cookie` value with the demo's fixed attribute set
// (httpOnly, SameSite=Lax, Path=/). Pulling a dep for ~30 lines isn't worth
// it; this is app code, not a library.
//
// SameSite=Lax (not None) is deliberate: the SPA and this server are
// same-site for the redirect-based login flow (browser-initiated
// top-level navigation to /auth/login carries the cookie on the callback),
// and the WS upgrade + /auth/* fetches are same-origin from the SPA's POV
// once it's redirected back. Lax avoids needing Secure+None for local http.

export interface SerializeCookieOptions {
  /** Max-Age in seconds. Omit for a session cookie (cleared on browser close). */
  maxAge?: number;
  /** Defaults to true — these are auth session cookies, never JS-readable. */
  httpOnly?: boolean;
  /** Defaults to "Lax". */
  sameSite?: "Lax" | "Strict" | "None";
  /** Defaults to "/". */
  path?: string;
  /** Set Secure (required when SameSite=None). Off by default for local http. */
  secure?: boolean;
}

/**
 * Read the value of a single named cookie out of a raw `Cookie:` header.
 * Returns `null` when the header is absent or the cookie isn't present.
 *
 * Cookie values are percent-decoded (we percent-encode on serialize) so a
 * round-trip is lossless. A malformed `%`-sequence falls back to the raw
 * value rather than throwing.
 */
export function parseCookie(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) return null;
  // `Cookie:` is a `; `-separated list of `name=value` pairs.
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    if (key !== name) continue;
    const raw = pair.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // Malformed percent-encoding — hand back the raw value rather than
      // throwing on a client-supplied header.
      return raw;
    }
  }
  return null;
}

/**
 * Serialize a single `Set-Cookie` header value with the demo's defaults.
 * The value is percent-encoded so it survives the `;`/`=` cookie grammar.
 */
export function serializeCookie(
  name: string,
  value: string,
  opts: SerializeCookieOptions = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (opts.httpOnly ?? true) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (typeof opts.maxAge === "number") parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}

/**
 * Serialize a cookie that clears an existing one (Max-Age=0 + empty value).
 */
export function clearCookie(
  name: string,
  opts: SerializeCookieOptions = {},
): string {
  return serializeCookie(name, "", { ...opts, maxAge: 0 });
}

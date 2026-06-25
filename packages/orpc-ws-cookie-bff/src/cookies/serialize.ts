// Hardened cookie serialize / parse / clear (§J).
//
// Grown from the demo's `shared/cookies.ts`, which ran over plain http and so
// shipped `SameSite=Lax`, no `Secure`, no `__Host-` prefix. The library
// targets production: `SameSite=Strict` by default (Decision #7 — viable
// because web/api/auth are subdomains of one registrable site), `Secure` by
// default, and full `__Host-` prefix invariants. Both `secure` and
// `hostPrefix` stay overridable so a localhost-http demo can switch them off.
//
// No `cookie` / `cookie-parser` dep: we need exactly serialize + parse + clear
// with this fixed attribute set; pulling a dependency for it isn't worth the
// supply-chain surface for a library that already forbids heavy deps.

/** Attribute set for a serialized `Set-Cookie` value. */
export interface SerializeCookieOptions {
  /**
   * Max-Age in seconds. Omit for a session cookie (cleared on browser
   * close). The `sid` cookie is PERSISTENT (default 30d) — NOT a session
   * cookie — so callers pass an explicit value there.
   */
  maxAge?: number;
  /** Defaults to true — auth cookies are never JS-readable. */
  httpOnly?: boolean;
  /** Defaults to "strict" (Decision #7). `lax` for cross-site top-level GETs. */
  sameSite?: "lax" | "strict";
  /** Defaults to "/". Forced to "/" when `hostPrefix` is set. */
  path?: string;
  /** Defaults to true. Forced on when `hostPrefix` is set. */
  secure?: boolean;
  /**
   * Cookie `Domain`. MUST be omitted when `hostPrefix` is set (the `__Host-`
   * prefix requires a host-only cookie); supplying one then throws.
   */
  domain?: string;
  /**
   * Enforce the `__Host-` cookie-prefix invariants: force `Secure`, force
   * `Path=/`, and forbid `Domain` (host-only). When true the caller is
   * responsible for naming the cookie with a `__Host-` prefix; this flag
   * enforces the attribute rules a browser requires for that prefix to be
   * honored. Defaults to false.
   */
  hostPrefix?: boolean;
}

const toSameSiteToken = (s: "lax" | "strict"): string =>
  s === "lax" ? "Lax" : "Strict";

/**
 * Read one named cookie out of a raw `Cookie:` header. Returns `null` when
 * the header is absent or the cookie isn't present. Values are
 * percent-decoded (we percent-encode on serialize) for a lossless round-trip;
 * a malformed `%`-sequence falls back to the raw value rather than throwing on
 * a client-supplied header.
 */
export function parseCookie(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    if (key !== name) continue;
    const raw = pair.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * Serialize a single `Set-Cookie` header value with the hardened defaults.
 * The value is percent-encoded so it survives the `;`/`=` cookie grammar.
 *
 * Throws when `hostPrefix` is set together with a `domain` — the `__Host-`
 * prefix is incompatible with a `Domain` attribute (browsers reject the
 * cookie), so we fail loudly rather than ship a cookie the browser drops.
 */
export function serializeCookie(
  name: string,
  value: string,
  opts: SerializeCookieOptions = {},
): string {
  const hostPrefix = opts.hostPrefix ?? false;

  if (hostPrefix && opts.domain !== undefined) {
    throw new Error(
      `Cookie "${name}": __Host- prefix (hostPrefix) forbids a Domain ` +
        `attribute — __Host- cookies are host-only.`,
    );
  }

  // __Host- forces Secure + Path=/ + no Domain. Otherwise honor the caller's
  // choices, defaulting to the hardened values.
  const secure = hostPrefix ? true : opts.secure ?? true;
  const path = hostPrefix ? "/" : opts.path ?? "/";

  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${path}`);
  if (!hostPrefix && opts.domain !== undefined) {
    parts.push(`Domain=${opts.domain}`);
  }
  parts.push(`SameSite=${toSameSiteToken(opts.sameSite ?? "strict")}`);
  if (opts.httpOnly ?? true) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (typeof opts.maxAge === "number") parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}

/**
 * Serialize a cookie that clears an existing one (`Max-Age=0` + empty value).
 * Pass the SAME `secure` / `sameSite` / `path` / `hostPrefix` attributes the
 * cookie was set with so the browser matches and removes it.
 */
export function clearCookie(
  name: string,
  opts: SerializeCookieOptions = {},
): string {
  return serializeCookie(name, "", { ...opts, maxAge: 0 });
}

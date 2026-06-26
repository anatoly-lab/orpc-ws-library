// OIDC Discovery — fetch + cache the `.well-known/openid-configuration`
// document for the verifier.
//
// Self-contained, Node-only: cache strategy, trailing-slash tolerance, and
// eviction-on-failure semantics all live here so the verifier carries no
// browser/DOM lib graph in its dependency surface.
//
// Cache strategy: module-level
// `Map<"${fetchUrl}\n${expectedIssuer}", Promise<OidcMetadata>>`.
//   - Storing the PROMISE means concurrent callers share one in-flight
//     fetch — N parallel initial verifies produce ONE network request.
//   - Keyed by the (fetch URL, expected issuer) PAIR, not the fetch URL
//     alone: a cached entry has already passed the issuer-mismatch
//     assertion for ITS expected issuer, so handing it to a caller with
//     a different expected issuer would silently skip that caller's
//     validation. Pair-keying keeps "cache hit" equivalent to
//     "fetch + validate succeeded for THIS config". When `discoveryUrl`
//     is omitted the two halves are equal, so per-issuer keying (the
//     old behavior) falls out unchanged.
//   - Module-level so a future operator who wires two verifyClients
//     for the same realm doesn't pay double discovery cost.
//
// On fetch failure we evict the rejected promise BEFORE re-throwing —
// otherwise a transient network blip would poison the cache for the
// process lifetime.
//
// Validation is minimal-by-design: only `issuer` and `jwks_uri` are
// required. The browser side needs four fields (auth/token endpoints
// for the PKCE flow); the verifier only needs the two it consumes.

import { OidcDiscoveryError, type OidcMetadata } from "./types.js";

/** Module-level cache of in-flight + resolved metadata promises. */
const metadataCache = new Map<string, Promise<OidcMetadata>>();

/**
 * Test-only cache reset. Not part of the public surface (`index.ts`).
 * `beforeEach` in tests calls this so each test starts cold.
 */
export function __resetMetadataCache(): void {
  metadataCache.clear();
}

/**
 * Strip a single trailing slash. Used on BOTH the configured issuerUrl
 * AND the `issuer` claim returned by discovery before comparing — IdPs
 * are inconsistent about the trailing slash, and a `===` would
 * false-reject perfectly valid configs.
 */
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Fetch + parse + validate the OIDC discovery document.
 *
 * `fetchUrl` is the base the document is FETCHED from;
 * `expectedIssuerUrl` is what the document's `issuer` field must equal
 * (trailing-slash normalized). They differ only in split-URL
 * deployments (`OidcVerifierConfig.discoveryUrl` set): the server
 * fetches over an internal host while the IdP advertises — and signs
 * into tokens — the public issuer. `expectedIssuerUrl` defaults to
 * `fetchUrl`, which is the classic single-URL behavior.
 *
 * Concurrent calls for the same (fetchUrl, expectedIssuer) pair share
 * one in-flight promise. After resolution the cache keeps the value
 * indefinitely — discovery docs are effectively static for the process
 * lifetime.
 *
 * Throws `OidcDiscoveryError` on:
 *   - non-2xx HTTP response,
 *   - non-JSON body,
 *   - missing required fields (`issuer`, `jwks_uri`),
 *   - issuer mismatch (after trailing-slash normalization).
 */
export async function fetchMetadata(
  fetchUrl: string,
  expectedIssuerUrl: string = fetchUrl,
): Promise<OidcMetadata> {
  // "\n" cannot appear in a URL, so the joined key is unambiguous.
  const cacheKey = `${fetchUrl}\n${expectedIssuerUrl}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) return cached;

  const promise = doFetch(fetchUrl, expectedIssuerUrl).catch(
    (err: unknown) => {
      // Evict on failure so a retry can re-attempt rather than getting
      // back the same poisoned promise forever.
      metadataCache.delete(cacheKey);
      throw err;
    },
  );
  metadataCache.set(cacheKey, promise);
  return promise;
}

async function doFetch(
  fetchUrl: string,
  expectedIssuerUrl: string,
): Promise<OidcMetadata> {
  const url = `${stripTrailingSlash(fetchUrl)}/.well-known/openid-configuration`;
  // Error `details.issuerUrl` carries the EXPECTED (public) issuer —
  // it identifies which verifier config failed; the message strings
  // carry the actually-fetched URL.
  const issuerUrl = expectedIssuerUrl;

  let resp: Response;
  try {
    resp = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new OidcDiscoveryError(
      `OIDC discovery network error for ${url}: ${e instanceof Error ? e.message : String(e)}`,
      { issuerUrl },
    );
  }

  if (!resp.ok) {
    const body = await safeReadBody(resp);
    throw new OidcDiscoveryError(
      `OIDC discovery failed: ${resp.status} ${resp.statusText} at ${url}`,
      { issuerUrl, status: resp.status, body },
    );
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch (e) {
    throw new OidcDiscoveryError(
      `OIDC discovery returned non-JSON body at ${url}: ${e instanceof Error ? e.message : String(e)}`,
      { issuerUrl },
    );
  }

  return validate(parsed, issuerUrl);
}

async function safeReadBody(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

/**
 * Validate the parsed JSON. Only the two fields the verifier consumes
 * are required: `issuer` (for the `jwtVerify` issuer assertion) and
 * `jwks_uri` (for `createRemoteJWKSet`).
 *
 * Issuer-mismatch check uses trailing-slash-normalized equality, NOT
 * strict equality — this guards the public-vs-internal URL case (the IdP
 * signs the public issuer into tokens even when discovery is fetched over
 * an internal host; see `discoveryUrl` in `types.ts`).
 */
function validate(raw: unknown, issuerUrl: string): OidcMetadata {
  if (typeof raw !== "object" || raw === null) {
    throw new OidcDiscoveryError(
      `OIDC discovery document is not an object`,
      { issuerUrl },
    );
  }
  const doc = raw as Record<string, unknown>;

  const required = ["issuer", "jwks_uri"] as const;
  for (const field of required) {
    if (typeof doc[field] !== "string" || (doc[field] as string).length === 0) {
      throw new OidcDiscoveryError(
        `OIDC discovery document missing required field "${field}"`,
        { issuerUrl },
      );
    }
  }

  const issuer = doc["issuer"] as string;
  if (stripTrailingSlash(issuer) !== stripTrailingSlash(issuerUrl)) {
    throw new OidcDiscoveryError(
      `OIDC discovery issuer mismatch: expected "${issuerUrl}", got "${issuer}". ` +
        `This usually means the public-facing URL the server was configured ` +
        `with differs from the URL the IdP signs into tokens.`,
      { issuerUrl },
    );
  }

  return {
    issuer,
    jwks_uri: doc["jwks_uri"] as string,
  };
}

/**
 * Lower-case ONLY the origin (scheme + host + port) of a URL string, leaving
 * the path + query untouched. Returns `null` for a non-URL string.
 *
 * Why split origin from the rest: per RFC 3986 the scheme and host are
 * case-INsensitive, but the path and query ARE case-sensitive. The WHATWG
 * `URL.origin` is already normalized to lower-case, so we use it as the
 * comparison key for the host half while preserving the path/query of the
 * original string verbatim (NOT `URL.pathname`, which would percent-encode /
 * normalize — we want a host-case fix only, not a full canonicalization).
 */
function originCaseFold(url: string): { origin: string; rest: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const schemeSep = url.indexOf("://");
  if (schemeSep === -1) return null;
  const authStart = schemeSep + 3;
  let restStart = url.length;
  for (let i = authStart; i < url.length; i++) {
    const c = url[i];
    if (c === "/" || c === "?" || c === "#") {
      restStart = i;
      break;
    }
  }
  return { origin: parsed.origin, rest: url.slice(restStart) };
}

/**
 * Resolve the URL to actually fetch JWKS from in a split-URL setup.
 *
 * The discovery doc's `jwks_uri` is advertised on the PUBLIC issuer
 * host (the IdP doesn't know it's also reachable internally), which the
 * server may not be able to reach. If `jwks_uri` lives under
 * `issuerUrl`, swap that prefix for `discoveryUrl` — same path, the
 * internally-reachable host. A `jwks_uri` on any other host (CDN-hosted
 * keys, non-split providers) is returned as-is.
 *
 * Host matching is case-INsensitive (RFC 3986 §3.2.2 / §6.2.2.1: scheme +
 * host are case-insensitive), while the path stays case-SENSITIVE: origins
 * are compared via the already-lower-cased WHATWG `URL.origin`, then the
 * path-prefix boundary is checked exactly. Prefix matching is
 * path-segment-safe: the issuer path must be followed by `/` (or match
 * exactly) so `http://h:80` never claims `http://h:8080/...` as its own.
 *
 * No-op when `discoveryUrl` equals `issuerUrl` (i.e. the field was
 * omitted) — back-compat fast path.
 */
export function rewriteJwksUri(
  jwksUri: string,
  issuerUrl: string,
  discoveryUrl: string,
): string {
  const publicBase = stripTrailingSlash(issuerUrl);
  const fetchBase = stripTrailingSlash(discoveryUrl);
  if (publicBase === fetchBase) return jwksUri;

  const uri = originCaseFold(jwksUri);
  const base = originCaseFold(publicBase);
  // If either isn't a parseable URL, fall back to exact-string semantics.
  if (!uri || !base) {
    return jwksUri === publicBase ? fetchBase : jwksUri;
  }

  // Opaque origins (file:/data:/custom schemes) all report `origin` as the
  // sentinel "null" per WHATWG URL, so two UNRELATED opaque URLs compare equal
  // — never treat that as the same origin (would wrongly rewrite).
  if (uri.origin === "null" || base.origin === "null") return jwksUri;

  if (uri.origin !== base.origin) return jwksUri;
  if (uri.rest === base.rest) return fetchBase;
  if (uri.rest.startsWith(`${base.rest}/`)) {
    return fetchBase + uri.rest.slice(base.rest.length);
  }
  return jwksUri;
}

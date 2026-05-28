// OIDC Discovery — fetch + cache the `.well-known/openid-configuration`
// document for the verifier.
//
// Mirrors `@repo/oidc-pkce/src/discovery.ts` (browser side) deliberately:
// same cache strategy, same trailing-slash tolerance, same eviction-on-
// failure semantics. The two cannot share code because the browser
// counterpart lives in a DOM-typed package and importing it from a
// Node-only package would drag the DOM lib graph into the server build.
// Symmetric duplication is the lesser evil — `~80 LOC` vs. a runtime
// coupling between two transports.
//
// Cache strategy: module-level `Map<issuerUrl, Promise<OidcMetadata>>`.
//   - Storing the PROMISE means concurrent callers share one in-flight
//     fetch — N parallel initial verifies produce ONE network request.
//   - Per-issuer keying lets one server talk to multiple IdPs (rare,
//     but cheap).
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
 * Fetch + parse + validate the OIDC discovery document for `issuerUrl`.
 *
 * Concurrent calls for the same issuer share one in-flight promise.
 * After resolution the cache keeps the value indefinitely — discovery
 * docs are effectively static for the process lifetime.
 *
 * Throws `OidcDiscoveryError` on:
 *   - non-2xx HTTP response,
 *   - non-JSON body,
 *   - missing required fields (`issuer`, `jwks_uri`),
 *   - issuer mismatch (after trailing-slash normalization).
 */
export async function fetchMetadata(issuerUrl: string): Promise<OidcMetadata> {
  const cached = metadataCache.get(issuerUrl);
  if (cached) return cached;

  const promise = doFetch(issuerUrl).catch((err: unknown) => {
    // Evict on failure so a retry can re-attempt rather than getting
    // back the same poisoned promise forever.
    metadataCache.delete(issuerUrl);
    throw err;
  });
  metadataCache.set(issuerUrl, promise);
  return promise;
}

async function doFetch(issuerUrl: string): Promise<OidcMetadata> {
  const url = `${stripTrailingSlash(issuerUrl)}/.well-known/openid-configuration`;

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
 * strict equality — see the comment in `@repo/oidc-pkce/discovery.ts`
 * for the public-vs-internal URL case this guards against.
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

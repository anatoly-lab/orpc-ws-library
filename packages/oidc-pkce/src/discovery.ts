// OIDC Discovery — fetch + cache the `.well-known/openid-configuration`
// document.
//
// Single source of truth for every IdP URL the library ever constructs.
// Anything that hits the IdP MUST go through the cached metadata; grep
// for `.well-known` should return only this file (and tests).
//
// Cache strategy: module-level `Map<issuerUrl, Promise<OidcMetadata>>`.
//   - Storing the PROMISE (not the resolved value) means concurrent
//     callers share one in-flight fetch — N flows in parallel hitting a
//     cold cache produce ONE network request, not N.
//   - Per-issuer keying lets one app talk to multiple IdPs (rare, but
//     cheap to support).
//   - Module-level (not per-instance) so two `createOidcAuth()` calls
//     against the same issuer share the cache; tests can punch through
//     with `__resetMetadataCache()` (see below).
//
// On fetch failure we evict the rejected promise from the cache before
// re-throwing — otherwise a transient network blip would poison the
// cache for the lifetime of the page.

import { OidcDiscoveryError, type OidcMetadata } from "./types.js";

/** Module-level cache of in-flight + resolved metadata promises. */
const metadataCache = new Map<string, Promise<OidcMetadata>>();

/**
 * Test-only cache reset. NOT exported from the package's public surface
 * (`index.ts`) — internal-only, intended for `beforeEach` in tests so
 * each test starts with a cold cache.
 *
 * The alternative (per-test unique issuer URLs) works but couples test
 * brittleness to the cache implementation; an explicit reset is the
 * idiomatic vitest pattern for module-level state.
 */
export function __resetMetadataCache(): void {
  metadataCache.clear();
}

/**
 * Strip a single trailing slash. Used on BOTH the configured issuerUrl
 * AND the issuer field returned in the discovery document before
 * comparing — IdPs are inconsistent about whether they include the
 * trailing slash, and a `===` comparison would falsely reject some
 * realm configs.
 */
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Fetch + parse + validate the OIDC discovery document for `issuerUrl`.
 *
 * Concurrent calls for the same issuer share one in-flight promise.
 * After resolution the cache keeps the value indefinitely — discovery
 * docs are effectively static for the lifetime of an SPA session.
 *
 * Throws `OidcDiscoveryError` on:
 *   - non-2xx HTTP response,
 *   - non-JSON body,
 *   - missing required fields (`issuer`, `authorization_endpoint`,
 *     `token_endpoint`, `jwks_uri`),
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
 * Validate the parsed JSON against the minimum field set we need.
 *
 * Issuer-mismatch check uses trailing-slash-normalized equality, NOT
 * strict equality:
 *   - Keycloak's `issuer` claim never includes a trailing slash;
 *   - operators sometimes set `KEYCLOAK_PUBLIC_URL=https://auth.example.com/`
 *     with a slash;
 *   - strict equality would false-reject that perfectly-valid setup.
 *
 * The normalized check still catches the cases we care about: scheme
 * mismatch (http vs https), wrong host, wrong realm path.
 */
function validate(raw: unknown, issuerUrl: string): OidcMetadata {
  if (typeof raw !== "object" || raw === null) {
    throw new OidcDiscoveryError(
      `OIDC discovery document is not an object`,
      { issuerUrl },
    );
  }
  const doc = raw as Record<string, unknown>;

  const required = [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
  ] as const;
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
        `This usually means the public-facing URL the SPA was configured with ` +
        `differs from the URL the IdP signs into tokens.`,
      { issuerUrl },
    );
  }

  const metadata: OidcMetadata = {
    issuer,
    authorization_endpoint: doc["authorization_endpoint"] as string,
    token_endpoint: doc["token_endpoint"] as string,
    jwks_uri: doc["jwks_uri"] as string,
  };
  if (typeof doc["end_session_endpoint"] === "string") {
    metadata.end_session_endpoint = doc["end_session_endpoint"];
  }
  if (typeof doc["userinfo_endpoint"] === "string") {
    metadata.userinfo_endpoint = doc["userinfo_endpoint"];
  }
  return metadata;
}

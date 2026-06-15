// OIDC endpoint discovery for the SERVER-side auth flows (backend-token +
// cookie-bff). Fetches `${issuerUrl}/.well-known/openid-configuration`
// once and caches the three endpoints the demo's code-exchange needs:
// authorization, token, end-session.
//
// This is the SPA-side half of discovery that the verifier
// (`@orpc-ws/oidc-verifier-jose`) deliberately does NOT expose — the
// verifier only reads `issuer` + `jwks_uri` (it never initiates a login).
// The backend modes DO initiate login, so they need the authorization +
// token endpoints. Rather than reach into the verifier package, the demo
// fetches discovery itself here (one extra roundtrip at first login,
// cached after) using the same issuer URL.
//
// Generic over any spec-compliant IdP — "keycloak" in the filename is just
// the demo's IdP; the fields are standard OIDC Discovery.

/** The endpoints the demo's server-side flows consume. */
export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** OPTIONAL — RP-initiated logout (`end_session_endpoint`). Not all IdPs advertise it. */
  endSessionEndpoint?: string;
}

/** Subset of the OIDC Discovery document this module reads. */
interface DiscoveryDocument {
  authorization_endpoint?: string;
  token_endpoint?: string;
  end_session_endpoint?: string;
}

// Module-level cache keyed by issuer URL. The demo runs one issuer per
// process, but keying by URL keeps this correct if that ever changes and
// dedups concurrent first-login callers.
const cache = new Map<string, Promise<OidcEndpoints>>();

/**
 * Fetch (once, then cached) the OIDC endpoints for `issuerUrl`. A single
 * trailing slash on `issuerUrl` is tolerated.
 *
 * Throws if discovery can't be fetched or is missing the required
 * authorization/token endpoints — a misconfigured IdP should fail loudly
 * at first login, not silently produce broken redirects.
 */
export function getOidcEndpoints(issuerUrl: string): Promise<OidcEndpoints> {
  const base = issuerUrl.replace(/\/+$/, "");
  const cached = cache.get(base);
  if (cached) return cached;

  const promise = fetchEndpoints(base).catch((err: unknown) => {
    // Don't cache a failed fetch — a transient IdP outage shouldn't
    // poison every subsequent login for the process lifetime.
    cache.delete(base);
    throw err;
  });
  cache.set(base, promise);
  return promise;
}

async function fetchEndpoints(base: string): Promise<OidcEndpoints> {
  const url = `${base}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `[keycloak-urls] discovery fetch failed: ${res.status} ${res.statusText} (${url})`,
    );
  }
  const doc = (await res.json()) as DiscoveryDocument;
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error(
      `[keycloak-urls] discovery doc missing authorization_endpoint/token_endpoint (${url})`,
    );
  }
  return {
    authorizationEndpoint: doc.authorization_endpoint,
    tokenEndpoint: doc.token_endpoint,
    ...(doc.end_session_endpoint
      ? { endSessionEndpoint: doc.end_session_endpoint }
      : {}),
  };
}

// OIDC endpoint discovery for the server-side auth flow.
//
// Grown from the demo's `keycloak-urls.ts`. Fetches
// `${discoveryUrl}/.well-known/openid-configuration` once and caches the
// endpoints the code-exchange / logout flows need. Generic over any
// spec-compliant IdP — "keycloak" is just this consumer's IdP.
//
// The `fetch` implementation is INJECTED (the `Fetcher` seam) so tests drive
// discovery + token calls with a fake, and a consumer can supply a fetch with
// a timeout / proxy. Discovery is cached per base URL; a failed fetch is NOT
// cached (a transient IdP outage must not poison every later login).

/** Minimal injectable HTTP seam — the subset of `fetch` this package uses. */
export type Fetcher = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

/** The endpoints the server-side flows consume. */
export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** OPTIONAL — RP-initiated logout. Not all IdPs advertise it. */
  endSessionEndpoint?: string;
}

/** Subset of the OIDC Discovery document this module reads. */
interface DiscoveryDocument {
  authorization_endpoint?: string;
  token_endpoint?: string;
  end_session_endpoint?: string;
}

/**
 * Caching discovery client. Construct once per process with the injected
 * `Fetcher`; reuse across logins.
 */
export class OidcDiscovery {
  private readonly cache = new Map<string, Promise<OidcEndpoints>>();

  constructor(private readonly fetcher: Fetcher) {}

  /**
   * The `Fetcher` this discovery instance was built with. Exposed so the
   * code-exchange reuses the same injected HTTP seam for token calls rather
   * than holding a second copy.
   */
  getFetcher(): Fetcher {
    return this.fetcher;
  }

  /**
   * Fetch (once, then cached) the OIDC endpoints for `discoveryUrl`. A
   * trailing slash is tolerated. Throws if discovery can't be fetched or
   * lacks the required authorization/token endpoints — a misconfigured IdP
   * fails loudly at first login, not silently with broken redirects.
   */
  getEndpoints(discoveryUrl: string): Promise<OidcEndpoints> {
    const base = discoveryUrl.replace(/\/+$/, "");
    const cached = this.cache.get(base);
    if (cached) return cached;

    const promise = this.fetchEndpoints(base).catch((err: unknown) => {
      // Don't cache a failed fetch — a transient outage shouldn't poison
      // every subsequent login for the process lifetime.
      this.cache.delete(base);
      throw err;
    });
    this.cache.set(base, promise);
    return promise;
  }

  private async fetchEndpoints(base: string): Promise<OidcEndpoints> {
    const url = `${base}/.well-known/openid-configuration`;
    const res = await this.fetcher(url);
    if (!res.ok) {
      throw new Error(
        `[cookie-bff] discovery fetch failed: ${res.status} ${res.statusText} (${url})`,
      );
    }
    const doc = (await res.json()) as DiscoveryDocument;
    if (!doc.authorization_endpoint || !doc.token_endpoint) {
      throw new Error(
        `[cookie-bff] discovery doc missing authorization_endpoint/token_endpoint (${url})`,
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
}

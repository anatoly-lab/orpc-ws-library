// discovery.test.ts — verifier-side OIDC Discovery (parallel to
// oidc-pkce/discovery.test.ts but trimmed for the smaller required-field
// set the verifier consumes — only `issuer` + `jwks_uri`).
//
// The bug-regression case ("evict a failed promise so a retry can
// succeed") mirrors the named test in oidc-pkce and is the regression
// fence for the cache-eviction discipline called out in the spec.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import {
  __resetMetadataCache,
  fetchMetadata,
  rewriteJwksUri,
} from "../discovery.js";
import { OidcDiscoveryError } from "../types.js";

/**
 * Build a Keycloak-shaped discovery doc. Keycloak emits more fields
 * than the verifier consumes — only `issuer` + `jwks_uri` are read,
 * but having the full shape catches accidental over-requirement.
 */
function keycloakDiscoveryDoc(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
    token_endpoint: `${issuer}/protocol/openid-connect/token`,
    end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
    jwks_uri: `${issuer}/protocol/openid-connect/certs`,
    userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
    grant_types_supported: ["authorization_code", "refresh_token"],
  };
}

function mockFetchOnce(body: unknown, init: ResponseInit = { status: 200 }) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(typeof body === "string" ? body : JSON.stringify(body), init),
  );
}

beforeEach(() => {
  __resetMetadataCache();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchMetadata — URL + parsing", () => {
  it("fetches `${issuerUrl}/.well-known/openid-configuration`", async () => {
    const issuer = "https://auth.example.com/realms/demo";
    const spy = mockFetchOnce(keycloakDiscoveryDoc(issuer));
    await fetchMetadata(issuer);
    const call = spy.mock.calls[0];
    if (!call) throw new Error("fetch not called");
    expect(call[0]).toBe(
      "https://auth.example.com/realms/demo/.well-known/openid-configuration",
    );
    expect((call[1]?.headers as Record<string, string>)?.Accept).toBe(
      "application/json",
    );
  });

  it("strips a single trailing slash from issuerUrl before joining", async () => {
    const issuer = "https://auth.example.com/realms/demo";
    const spy = mockFetchOnce(keycloakDiscoveryDoc(issuer));
    await fetchMetadata(`${issuer}/`);
    const call = spy.mock.calls[0];
    if (!call) throw new Error("fetch not called");
    expect(call[0]).toBe(
      "https://auth.example.com/realms/demo/.well-known/openid-configuration",
    );
  });

  it("returns the parsed metadata (issuer + jwks_uri only)", async () => {
    const issuer = "https://auth.example.com/realms/demo";
    mockFetchOnce(keycloakDiscoveryDoc(issuer));
    const meta = await fetchMetadata(issuer);
    expect(meta.issuer).toBe(issuer);
    expect(meta.jwks_uri).toBe(`${issuer}/protocol/openid-connect/certs`);
  });

  it("does not require auth/token endpoints (verifier-only doc shape)", async () => {
    const issuer = "https://auth.example.com/realms/demo";
    // Minimal doc — only the two fields the verifier consumes.
    mockFetchOnce({
      issuer,
      jwks_uri: `${issuer}/keys`,
    });
    const meta = await fetchMetadata(issuer);
    expect(meta.jwks_uri).toBe(`${issuer}/keys`);
  });
});

describe("fetchMetadata — error handling", () => {
  it("throws OidcDiscoveryError on non-2xx", async () => {
    mockFetchOnce("not found", { status: 404 });
    await expect(
      fetchMetadata("https://auth.example.com/realms/missing"),
    ).rejects.toBeInstanceOf(OidcDiscoveryError);
  });

  it("throws OidcDiscoveryError on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("down"));
    await expect(
      fetchMetadata("https://auth.example.com/realms/demo"),
    ).rejects.toBeInstanceOf(OidcDiscoveryError);
  });

  it("throws OidcDiscoveryError on non-JSON response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>not json</html>", { status: 200 }),
    );
    await expect(
      fetchMetadata("https://auth.example.com/realms/demo"),
    ).rejects.toBeInstanceOf(OidcDiscoveryError);
  });

  it("throws when jwks_uri is missing", async () => {
    const issuer = "https://auth.example.com/realms/demo";
    mockFetchOnce({ issuer });
    await expect(fetchMetadata(issuer)).rejects.toBeInstanceOf(
      OidcDiscoveryError,
    );
  });

  it("throws when the issuer claim does not match issuerUrl", async () => {
    const issuer = "https://auth.example.com/realms/demo";
    mockFetchOnce(
      keycloakDiscoveryDoc("http://internal.svc.cluster.local/realms/demo"),
    );
    await expect(fetchMetadata(issuer)).rejects.toBeInstanceOf(
      OidcDiscoveryError,
    );
  });

  it("tolerates a trailing slash mismatch on the issuer claim", async () => {
    const issuerWithSlash = "https://auth.example.com/realms/demo/";
    const issuerNoSlash = "https://auth.example.com/realms/demo";
    mockFetchOnce(keycloakDiscoveryDoc(issuerNoSlash));
    const meta = await fetchMetadata(issuerWithSlash);
    expect(meta.issuer).toBe(issuerNoSlash);
  });
});

describe("fetchMetadata — caching", () => {
  it("returns the same promise for concurrent calls with the same issuer", async () => {
    const issuer = "https://auth.example.com/realms/demo";
    const spy = mockFetchOnce(keycloakDiscoveryDoc(issuer));
    const [a, b] = await Promise.all([
      fetchMetadata(issuer),
      fetchMetadata(issuer),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("caches the resolved value across sequential calls", async () => {
    const issuer = "https://auth.example.com/realms/demo";
    const spy = mockFetchOnce(keycloakDiscoveryDoc(issuer));
    await fetchMetadata(issuer);
    await fetchMetadata(issuer);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // Bug regression: without eviction, the first failure poisons the
  // cache forever — every subsequent verify replays the same rejected
  // promise and the IdP never gets a real retry.
  it("evicts a failed promise so a retry can succeed", async () => {
    const issuer = "https://auth.example.com/realms/demo";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("oops", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(keycloakDiscoveryDoc(issuer)), {
          status: 200,
        }),
      );
    await expect(fetchMetadata(issuer)).rejects.toBeInstanceOf(
      OidcDiscoveryError,
    );
    const meta = await fetchMetadata(issuer);
    expect(meta.issuer).toBe(issuer);
  });

  it("keys the cache by issuerUrl (two issuers => two fetches)", async () => {
    const a = "https://auth.example.com/realms/demo";
    const b = "https://auth.example.com/realms/prod";
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(keycloakDiscoveryDoc(a)), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(keycloakDiscoveryDoc(b)), { status: 200 }),
      );
    await fetchMetadata(a);
    await fetchMetadata(b);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("fetchMetadata — split fetch URL vs expected issuer", () => {
  // Split-URL deployments (`OidcVerifierConfig.discoveryUrl`): fetch
  // over the internal host, validate `issuer` against the public URL.
  const PUBLIC_ISSUER = "http://public.example:18080/realms/demo";
  const INTERNAL_BASE = "http://internal.example:8080/realms/demo";

  it("fetches from the fetch URL while validating issuer against the expected issuer", async () => {
    // KC_HOSTNAME-pinned IdP: the doc fetched internally still
    // advertises the PUBLIC issuer.
    const spy = mockFetchOnce(keycloakDiscoveryDoc(PUBLIC_ISSUER));
    const meta = await fetchMetadata(INTERNAL_BASE, PUBLIC_ISSUER);
    const call = spy.mock.calls[0];
    if (!call) throw new Error("fetch not called");
    expect(call[0]).toBe(
      `${INTERNAL_BASE}/.well-known/openid-configuration`,
    );
    expect(meta.issuer).toBe(PUBLIC_ISSUER);
  });

  it("rejects when the doc's issuer matches the fetch URL instead of the expected issuer", async () => {
    // Misconfigured IdP (no public-hostname pinning): the doc echoes
    // the internal URL — must be rejected against the PUBLIC issuer.
    mockFetchOnce(keycloakDiscoveryDoc(INTERNAL_BASE));
    await expect(
      fetchMetadata(INTERNAL_BASE, PUBLIC_ISSUER),
    ).rejects.toBeInstanceOf(OidcDiscoveryError);
  });

  it("keys the cache by the (fetch URL, expected issuer) PAIR — a hit never skips issuer validation", async () => {
    // Same fetch URL, two different expected issuers. If the cache were
    // keyed by fetch URL alone, the second call would get the first
    // call's (valid-for-A) metadata WITHOUT re-validating — silently
    // accepting an issuer it should reject. Pair-keying forces a second
    // fetch + its own validation, which fails here.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
      // Fresh Response per call — a Response body is single-use.
      async () =>
        new Response(JSON.stringify(keycloakDiscoveryDoc(PUBLIC_ISSUER)), {
          status: 200,
        }),
    );
    const meta = await fetchMetadata(INTERNAL_BASE, PUBLIC_ISSUER);
    expect(meta.issuer).toBe(PUBLIC_ISSUER);
    await expect(
      fetchMetadata(INTERNAL_BASE, "http://other.example/realms/demo"),
    ).rejects.toThrow(/issuer mismatch/);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("omitting the expected issuer defaults it to the fetch URL (back-compat single-URL behavior)", async () => {
    const issuer = "https://auth.example.com/realms/demo";
    const spyA = mockFetchOnce(keycloakDiscoveryDoc(issuer));
    const one = await fetchMetadata(issuer);
    // Explicit two-arg form with equal halves shares the same cache
    // entry — no second fetch.
    const two = await fetchMetadata(issuer, issuer);
    expect(one).toBe(two);
    expect(spyA).toHaveBeenCalledTimes(1);
  });
});

describe("rewriteJwksUri", () => {
  const PUBLIC_ISSUER = "http://public.example:18080/realms/demo";
  const INTERNAL_BASE = "http://internal.example:8080/realms/demo";

  it("rewrites the issuer prefix to the discovery base", () => {
    expect(
      rewriteJwksUri(
        `${PUBLIC_ISSUER}/protocol/openid-connect/certs`,
        PUBLIC_ISSUER,
        INTERNAL_BASE,
      ),
    ).toBe(`${INTERNAL_BASE}/protocol/openid-connect/certs`);
  });

  it("is a no-op when discoveryUrl equals issuerUrl (back-compat path)", () => {
    const jwks = `${PUBLIC_ISSUER}/protocol/openid-connect/certs`;
    expect(rewriteJwksUri(jwks, PUBLIC_ISSUER, PUBLIC_ISSUER)).toBe(jwks);
  });

  it("leaves a foreign-host jwks_uri untouched", () => {
    const jwks = "https://keys.cdn.example/jwks.json";
    expect(rewriteJwksUri(jwks, PUBLIC_ISSUER, INTERNAL_BASE)).toBe(jwks);
  });

  it("tolerates trailing slashes on both bases", () => {
    expect(
      rewriteJwksUri(
        `${PUBLIC_ISSUER}/certs`,
        `${PUBLIC_ISSUER}/`,
        `${INTERNAL_BASE}/`,
      ),
    ).toBe(`${INTERNAL_BASE}/certs`);
  });

  it("does not treat a longer port as a prefix match (path-segment boundary)", () => {
    // "http://h:1808" must not claim "http://h:18080/..." — the prefix
    // check requires a "/" boundary after the issuer base.
    const jwks = "http://public.example:18080/realms/demo/certs";
    expect(
      rewriteJwksUri(jwks, "http://public.example:1808", INTERNAL_BASE),
    ).toBe(jwks);
  });
});

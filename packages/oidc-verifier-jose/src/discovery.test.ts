// discovery.test.ts — verifier-side OIDC Discovery (parallel to
// oidc-pkce/discovery.test.ts but trimmed for the smaller required-field
// set the verifier consumes — only `issuer` + `jwks_uri`).
//
// The bug-regression case ("evict a failed promise so a retry can
// succeed") mirrors the named test in oidc-pkce and is the regression
// fence for the cache-eviction discipline called out in the spec.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { __resetMetadataCache, fetchMetadata } from "./discovery.js";
import { OidcDiscoveryError } from "./types.js";

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

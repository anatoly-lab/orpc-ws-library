// discovery.test.ts — OIDC Discovery fetch + validate + cache.
//
// Replaces the keycloak-browser endpoints.test.ts. Where that file
// pinned the four hard-coded Keycloak URL shapes, this file pins:
//   - the discovery doc URL we fetch,
//   - required-field validation,
//   - issuer-mismatch detection (with trailing-slash tolerance),
//   - the module-level cache (single in-flight per issuer, evict on
//     failure).
//
// The "compat against old Keycloak endpoints" check lives in
// flow.test.ts ("Keycloak-shaped discovery") rather than here — that's
// where the resulting authorize URL gets compared end-to-end.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import {
  __resetMetadataCache,
  fetchMetadata,
} from "./discovery.js";
import { OidcDiscoveryError } from "./types.js";

/**
 * Build a Keycloak-shaped discovery doc for `issuer`. Matches the
 * actual shape Keycloak 26.5.5 emits on `/realms/x/.well-known/
 * openid-configuration` — verified against the realm json fixture
 * at `tests-e2e/setup/keycloak/orpc-ws-demo-realm.json`.
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
    // Library requests JSON explicitly so an IdP that content-negotiates
    // doesn't hand us HTML.
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
    // No double-slash.
    expect(call[0]).toBe(
      "https://auth.example.com/realms/demo/.well-known/openid-configuration",
    );
  });

  it("returns the parsed metadata on a 2xx JSON response", async () => {
    const issuer = "https://auth.example.com/realms/demo";
    mockFetchOnce(keycloakDiscoveryDoc(issuer));
    const meta = await fetchMetadata(issuer);
    expect(meta.issuer).toBe(issuer);
    expect(meta.authorization_endpoint).toBe(
      `${issuer}/protocol/openid-connect/auth`,
    );
    expect(meta.token_endpoint).toBe(
      `${issuer}/protocol/openid-connect/token`,
    );
    expect(meta.end_session_endpoint).toBe(
      `${issuer}/protocol/openid-connect/logout`,
    );
    expect(meta.jwks_uri).toBe(`${issuer}/protocol/openid-connect/certs`);
  });

  it("treats `end_session_endpoint` as optional", async () => {
    const issuer = "https://auth.example.com";
    const doc = keycloakDiscoveryDoc(issuer);
    delete doc["end_session_endpoint"];
    mockFetchOnce(doc);
    const meta = await fetchMetadata(issuer);
    expect(meta.end_session_endpoint).toBeUndefined();
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

  it("throws when a required field is missing (authorization_endpoint)", async () => {
    const issuer = "https://auth.example.com/realms/demo";
    const doc = keycloakDiscoveryDoc(issuer);
    delete (doc as Record<string, unknown>)["authorization_endpoint"];
    mockFetchOnce(doc);
    await expect(fetchMetadata(issuer)).rejects.toBeInstanceOf(
      OidcDiscoveryError,
    );
  });

  it("throws when the issuer claim does not match issuerUrl", async () => {
    // SPA configured with https://auth.example.com but Keycloak signs
    // tokens with http://internal.svc.cluster.local — exactly the
    // public-vs-internal misconfig the check is here to catch.
    const issuer = "https://auth.example.com/realms/demo";
    mockFetchOnce(
      keycloakDiscoveryDoc("http://internal.svc.cluster.local/realms/demo"),
    );
    await expect(fetchMetadata(issuer)).rejects.toBeInstanceOf(
      OidcDiscoveryError,
    );
  });

  it("tolerates a trailing slash mismatch on the issuer claim", async () => {
    // Operator sets KEYCLOAK_PUBLIC_URL=https://auth.example.com/ (with
    // slash) -> issuerUrl='.../demo/'. Keycloak's `issuer` claim never
    // includes the trailing slash. Strict equality would false-reject.
    const issuerWithSlash = "https://auth.example.com/realms/demo/";
    const issuerNoSlash = "https://auth.example.com/realms/demo";
    mockFetchOnce(keycloakDiscoveryDoc(issuerNoSlash));
    const meta = await fetchMetadata(issuerWithSlash);
    expect(meta.issuer).toBe(issuerNoSlash);
  });
});

describe("fetchMetadata — caching", () => {
  it("returns the same promise for concurrent calls with the same issuer", async () => {
    // Two parallel callers should share ONE fetch.
    const issuer = "https://auth.example.com/realms/demo";
    const spy = mockFetchOnce(keycloakDiscoveryDoc(issuer));
    const [a, b] = await Promise.all([
      fetchMetadata(issuer),
      fetchMetadata(issuer),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a).toBe(b); // same object reference — resolved-once promise
  });

  it("caches the resolved value across sequential calls", async () => {
    const issuer = "https://auth.example.com/realms/demo";
    const spy = mockFetchOnce(keycloakDiscoveryDoc(issuer));
    await fetchMetadata(issuer);
    await fetchMetadata(issuer);
    expect(spy).toHaveBeenCalledTimes(1);
  });

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
    // Retry — without eviction this would resolve to the same poisoned
    // promise and reject again.
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

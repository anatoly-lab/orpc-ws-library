// Regression: split-horizon OIDC deployment — the public issuer URL differs
// from the internal discovery URL. Keycloak advertises ALL endpoints on the
// PUBLIC host; the server-side token exchange/refresh must POST to the
// INTERNAL host or it gets `fetch failed`. cookie-bff rewrites only the
// SERVER back-channel `token_endpoint`; the BROWSER-facing
// `authorization_endpoint` and `end_session_endpoint` stay PUBLIC.
//
// Mirrors the `jwks_uri` rewrite in `@orpc-ws/oidc-verifier-jose`.

import { describe, expect, it } from "vitest";

import { OidcDiscovery } from "../discovery.js";
import { rewriteBackChannelEndpoint } from "../endpoint-rewrite.js";
import { fakeFetcher } from "../../__tests__/fakes.js";

const PUBLIC = "http://localhost:18080";
const INTERNAL = "http://keycloak:8080";

/** A split-horizon discovery doc: everything advertised on the PUBLIC host. */
function splitHorizonFetcher() {
  return fakeFetcher({
    discovery: {
      ok: true,
      status: 200,
      json: {
        authorization_endpoint: `${PUBLIC}/realms/demo/protocol/openid-connect/auth`,
        token_endpoint: `${PUBLIC}/realms/demo/protocol/openid-connect/token`,
        end_session_endpoint: `${PUBLIC}/realms/demo/protocol/openid-connect/logout`,
      },
    },
  });
}

describe("split-horizon token_endpoint rewrite", () => {
  it("rewrites the back-channel token_endpoint to the internal discovery host", async () => {
    const discovery = new OidcDiscovery(splitHorizonFetcher(), {
      issuerUrl: PUBLIC,
      discoveryUrl: INTERNAL,
    });

    // Discovery is FETCHED from the internal host (the cache key) ...
    const endpoints = await discovery.getEndpoints(INTERNAL);

    // ... and the advertised token_endpoint (public host) is rewritten to the
    // internal host, PRESERVING the path.
    expect(endpoints.tokenEndpoint).toBe(
      `${INTERNAL}/realms/demo/protocol/openid-connect/token`,
    );
  });

  it("leaves the browser-facing authorization_endpoint and end_session_endpoint PUBLIC", async () => {
    const discovery = new OidcDiscovery(splitHorizonFetcher(), {
      issuerUrl: PUBLIC,
      discoveryUrl: INTERNAL,
    });

    const endpoints = await discovery.getEndpoints(INTERNAL);

    // The browser is redirected/navigated to these — they MUST stay public.
    expect(endpoints.authorizationEndpoint).toBe(
      `${PUBLIC}/realms/demo/protocol/openid-connect/auth`,
    );
    expect(endpoints.endSessionEndpoint).toBe(
      `${PUBLIC}/realms/demo/protocol/openid-connect/logout`,
    );
  });

  it("is a no-op when no split-horizon policy is configured (single-URL deployment)", async () => {
    const discovery = new OidcDiscovery(splitHorizonFetcher());

    const endpoints = await discovery.getEndpoints(PUBLIC);

    expect(endpoints.tokenEndpoint).toBe(
      `${PUBLIC}/realms/demo/protocol/openid-connect/token`,
    );
  });

  it("is a no-op when discoveryUrl equals issuerUrl", async () => {
    const discovery = new OidcDiscovery(splitHorizonFetcher(), {
      issuerUrl: PUBLIC,
      discoveryUrl: PUBLIC,
    });

    const endpoints = await discovery.getEndpoints(PUBLIC);

    expect(endpoints.tokenEndpoint).toBe(
      `${PUBLIC}/realms/demo/protocol/openid-connect/token`,
    );
  });
});

describe("rewriteBackChannelEndpoint (pure helper)", () => {
  it("swaps only the public host prefix, preserving path + query", () => {
    expect(
      rewriteBackChannelEndpoint(`${PUBLIC}/token?foo=bar`, PUBLIC, INTERNAL),
    ).toBe(`${INTERNAL}/token?foo=bar`);
  });

  it("returns the endpoint unchanged when discoveryUrl is undefined", () => {
    expect(
      rewriteBackChannelEndpoint(`${PUBLIC}/token`, PUBLIC, undefined),
    ).toBe(`${PUBLIC}/token`);
  });

  it("returns the endpoint unchanged when issuer and discovery are equal", () => {
    expect(rewriteBackChannelEndpoint(`${PUBLIC}/token`, PUBLIC, PUBLIC)).toBe(
      `${PUBLIC}/token`,
    );
  });

  it("tolerates a trailing slash on either base", () => {
    expect(
      rewriteBackChannelEndpoint(
        `${PUBLIC}/token`,
        `${PUBLIC}/`,
        `${INTERNAL}/`,
      ),
    ).toBe(`${INTERNAL}/token`);
  });

  it("leaves a token endpoint hosted on a foreign origin as advertised", () => {
    const foreign = "https://tokens.cdn.example/token";
    expect(rewriteBackChannelEndpoint(foreign, PUBLIC, INTERNAL)).toBe(foreign);
  });

  it("is path-segment-safe (a longer-port host is not a prefix match)", () => {
    // `http://h:80` must NOT claim `http://h:8080/...`.
    expect(
      rewriteBackChannelEndpoint(
        "http://h:8080/token",
        "http://h:80",
        "http://internal",
      ),
    ).toBe("http://h:8080/token");
  });

  it("never rewrites an opaque-origin endpoint (opaque origins all compare equal as \"null\")", () => {
    // file:/data:/custom-scheme URLs report origin "null", so two UNRELATED
    // opaque URLs would falsely match on origin — must stay UNCHANGED.
    const opaque = "foo://evil/token";
    expect(
      rewriteBackChannelEndpoint(opaque, "foo://issuer/realm", INTERNAL),
    ).toBe(opaque);
  });

  it("matches the host case-INsensitively (RFC 3986: host is case-insensitive)", () => {
    // The IdP advertises an UPPER-CASE host; the configured issuer is
    // lower-case. Per RFC 3986 these are the SAME origin, so the back-channel
    // endpoint must still be rewritten (the host-case-sensitive raw-string
    // match used to silently no-op here). Path stays exact (case-sensitive).
    expect(
      rewriteBackChannelEndpoint(
        "http://LOCALHOST:18080/realms/demo/Token",
        PUBLIC,
        INTERNAL,
      ),
    ).toBe(`${INTERNAL}/realms/demo/Token`);
  });
});

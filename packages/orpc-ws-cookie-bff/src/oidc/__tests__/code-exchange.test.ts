import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { OidcCodeExchange } from "../code-exchange.js";
import { OidcDiscovery } from "../discovery.js";
import { InMemoryPkceStore, type PkceStore } from "../pkce-store.js";
import { fakeClock, fakeFetcher } from "../../__tests__/fakes.js";

const config = {
  issuerUrl: "https://idp.example",
  clientId: "demo-client",
  redirectUri: "https://api.example/auth/callback",
};

function build(opts: {
  pkceStore?: PkceStore;
  token?: Parameters<typeof fakeFetcher>[0]["token"];
}) {
  const clock = fakeClock();
  const fetcher = fakeFetcher({ token: opts.token });
  const discovery = new OidcDiscovery(fetcher);
  const pkceStore = opts.pkceStore ?? new InMemoryPkceStore(clock);
  const exchange = new OidcCodeExchange(config, {
    discovery,
    pkceStore,
    clock,
  });
  return { exchange, fetcher, pkceStore, clock };
}

describe("OidcCodeExchange.createAuthorizationUrl", () => {
  it("builds a spec-compliant authorize URL with an S256 challenge", async () => {
    const pkceStore = new InMemoryPkceStore(fakeClock());
    const { exchange } = build({ pkceStore });
    const { url, state } = await exchange.createAuthorizationUrl();

    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://idp.example/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("demo-client");
    expect(u.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(u.searchParams.get("scope")).toBe("openid profile email");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe(state);

    // The stored verifier must hash (S256) to the challenge in the URL.
    const verifier = await pkceStore.take(state);
    expect(verifier).toBeTruthy();
    const expectedChallenge = createHash("sha256")
      .update(verifier!)
      .digest()
      .toString("base64url");
    expect(u.searchParams.get("code_challenge")).toBe(expectedChallenge);
  });

  it("merges authorizeParams into the URL (F3)", async () => {
    const exchange = new OidcCodeExchange(
      {
        ...config,
        authorizeParams: { prompt: "select_account", ui_locales: "en" },
      },
      {
        discovery: new OidcDiscovery(fakeFetcher({})),
        pkceStore: new InMemoryPkceStore(fakeClock()),
        clock: fakeClock(),
      },
    );
    const { url } = await exchange.createAuthorizationUrl();
    const u = new URL(url);
    expect(u.searchParams.get("prompt")).toBe("select_account");
    expect(u.searchParams.get("ui_locales")).toBe("en");
    // The security params are still present + correct.
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("a consumer authorizeParam CANNOT clobber the security-critical params (F3)", async () => {
    const exchange = new OidcCodeExchange(
      {
        ...config,
        authorizeParams: {
          // Hostile/clumsy attempts to override the fixed params:
          redirect_uri: "https://evil.example/steal",
          code_challenge: "attacker-controlled",
          code_challenge_method: "plain",
          response_type: "token",
          scope: "openid evil",
          client_id: "someone-else",
        },
      },
      {
        discovery: new OidcDiscovery(fakeFetcher({})),
        pkceStore: new InMemoryPkceStore(fakeClock()),
        clock: fakeClock(),
      },
    );
    const { url } = await exchange.createAuthorizationUrl();
    const u = new URL(url);
    // The library's fixed values win — the overrides are ignored.
    expect(u.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(u.searchParams.get("code_challenge")).not.toBe("attacker-controlled");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid profile email");
    expect(u.searchParams.get("client_id")).toBe("demo-client");
  });
});

describe("OidcCodeExchange.exchangeCode", () => {
  it("round-trips state via the seam and returns a TokenSet", async () => {
    const { exchange, fetcher } = build({
      token: {
        ok: true,
        status: 200,
        json: {
          access_token: "acc",
          refresh_token: "ref",
          id_token: "id",
          expires_in: 300,
        },
      },
    });
    const { state } = await exchange.createAuthorizationUrl();
    const tokens = await exchange.exchangeCode("the-code", state);
    expect(tokens).toEqual({
      accessToken: "acc",
      refreshToken: "ref",
      idToken: "id",
      expiresIn: 300,
    });
    // The token POST carried the PKCE verifier + the code.
    const tokenCall = fetcher.calls.find((c) => c.url.includes("/token"));
    expect(tokenCall?.body).toContain("code=the-code");
    expect(tokenCall?.body).toContain("code_verifier=");
    expect(tokenCall?.body).toContain("grant_type=authorization_code");
  });

  it("rejects a replayed/unknown state (single-use verifier)", async () => {
    const { exchange } = build({
      token: { ok: true, status: 200, json: { access_token: "a" } },
    });
    const { state } = await exchange.createAuthorizationUrl();
    await exchange.exchangeCode("c", state); // consumes the verifier
    await expect(exchange.exchangeCode("c", state)).rejects.toThrow(
      /unknown or expired state/,
    );
  });

  it("defaults expires_in to 300 when the IdP omits it", async () => {
    const { exchange } = build({
      token: { ok: true, status: 200, json: { access_token: "a" } },
    });
    const { state } = await exchange.createAuthorizationUrl();
    const tokens = await exchange.exchangeCode("c", state);
    expect(tokens.expiresIn).toBe(300);
    expect(tokens.refreshToken).toBeNull();
  });

  it("throws TokenEndpointError carrying the HTTP status on failure", async () => {
    const { exchange } = build({
      token: { ok: false, status: 400, statusText: "Bad Request", text: "nope" },
    });
    const { state } = await exchange.createAuthorizationUrl();
    await expect(exchange.exchangeCode("c", state)).rejects.toMatchObject({
      name: "TokenEndpointError",
      status: 400,
    });
  });
});

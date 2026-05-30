// client.test.ts — composition + tokenProvider behavior.
//
// Validates that `createOidcAuth` composes the right pieces:
//   - default storage is used when none provided
//   - `tokenProvider.getToken/refresh` behave per contract
//   - status / user methods read through storage (no caching surprises)
//   - discovery is awaited on first auth-method call (and not before)
//
// The refresh-purity regression lives in its own file
// (`bug-refresh-purity.test.ts`) so a grep on "purity" surfaces it.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { createOidcAuth, type OidcAuth } from "../client.js";
import { __resetMetadataCache } from "../discovery.js";
import type { OidcConfig, Storage, Tokens } from "../types.js";

// Compile-time guard: the returned tokenProvider must remain
// structurally compatible with @repo/orpc-ws-client's TokenProvider.
// We inline an identical-shape interface here (re-importing from the
// client package would add a runtime dep we don't want) — TypeScript's
// structural typing makes the `satisfies` check fail if the shapes drift.
// The assertion executes no code; the test below only ensures the file
// type-checks under vitest.
interface OrpcWsTokenProvider {
  getToken(): string | null;
  refresh(): Promise<string | null>;
}
type AssertTokenProviderCompat = OidcAuth["tokenProvider"] extends OrpcWsTokenProvider
  ? true
  : false;
const _tokenProviderCompat: AssertTokenProviderCompat = true;
void _tokenProviderCompat;

const CONFIG: OidcConfig = {
  issuerUrl: "https://auth.example.com/realms/demo",
  clientId: "spa",
  redirectUri: "https://app.example.com/auth/callback",
};

// Keycloak-shaped discovery doc — mirrors what a real Keycloak 26 emits.
function keycloakDoc(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
    token_endpoint: `${issuer}/protocol/openid-connect/token`,
    end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
    jwks_uri: `${issuer}/protocol/openid-connect/certs`,
  };
}

/** Mock the discovery fetch. Returns the spy so callers can assert. */
function mockDiscovery() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/.well-known/openid-configuration")) {
        return Promise.resolve(
          new Response(JSON.stringify(keycloakDoc(CONFIG.issuerUrl)), {
            status: 200,
          }),
        );
      }
      // Default token-endpoint response — tests that care about token
      // exchange override this with a more specific mock.
      return Promise.resolve(new Response("not mocked", { status: 500 }));
    });
}

function makeStorage(initial: Tokens | null = null): Storage & {
  reads: number;
  writes: Tokens[];
  clears: number;
} {
  let value = initial;
  const counts = { reads: 0, writes: [] as Tokens[], clears: 0 };
  return {
    read: () => {
      counts.reads += 1;
      return value;
    },
    write: (t) => {
      counts.writes.push(t);
      value = t;
    },
    clear: () => {
      counts.clears += 1;
      value = null;
    },
    get reads() {
      return counts.reads;
    },
    get writes() {
      return counts.writes;
    },
    get clears() {
      return counts.clears;
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  __resetMetadataCache();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("createOidcAuth — defaults + status", () => {
  it("defaults to localStorage when no storage option is passed", () => {
    const auth = createOidcAuth(CONFIG);
    expect(auth.hasToken()).toBe(false);
    expect(auth.getAuthStatus()).toBe("anonymous");
    // Plant a token via the default storage and observe it.
    localStorage.setItem(
      "oidc.tokens",
      JSON.stringify({
        accessToken: "AT",
        refreshToken: "RT",
        idToken: "IT",
        expiresAt: Date.now() + 60_000,
      }),
    );
    expect(auth.hasToken()).toBe(true);
    expect(auth.getAuthStatus()).toBe("authenticated");
  });

  it("uses the injected storage when provided", () => {
    const storage = makeStorage();
    const auth = createOidcAuth(CONFIG, { storage });
    expect(auth.hasToken()).toBe(false);
    expect(storage.reads).toBeGreaterThan(0);
  });

  it("reports expired status when stored token has passed expiresAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const storage = makeStorage({
      accessToken: "AT",
      refreshToken: "RT",
      idToken: "IT",
      expiresAt: Date.now() - 1,
    });
    const auth = createOidcAuth(CONFIG, { storage });
    expect(auth.getAuthStatus()).toBe("expired");
    expect(auth.isAccessTokenValid()).toBe(false);
    vi.useRealTimers();
  });

  it("clearTokens calls storage.clear", () => {
    const storage = makeStorage({
      accessToken: "AT",
      refreshToken: "RT",
      idToken: "IT",
      expiresAt: Date.now() + 60_000,
    });
    const auth = createOidcAuth(CONFIG, { storage });
    auth.clearTokens();
    expect(storage.clears).toBe(1);
    expect(auth.hasToken()).toBe(false);
  });

  it("getUser returns null when no tokens stored", () => {
    const storage = makeStorage();
    const auth = createOidcAuth(CONFIG, { storage });
    expect(auth.getUser()).toBeNull();
  });

  it("getUser parses the id_token when stored (standard OIDC claims only)", () => {
    const idToken =
      "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiJ1c2VyLWFiYy0xMjMiLCJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIiwibmFtZSI6IkFsaWNlIEV4YW1wbGUiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiJhbGljZSIsInJlYWxtX2FjY2VzcyI6eyJyb2xlcyI6WyJhZG1pbiIsInVzZXIiXX0sImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAzNjAwfQ." +
      "sig";
    const storage = makeStorage({
      accessToken: "AT",
      refreshToken: "RT",
      idToken,
      expiresAt: Date.now() + 60_000,
    });
    const auth = createOidcAuth(CONFIG, { storage });
    expect(auth.getUser()?.sub).toBe("user-abc-123");
    // Confirms the OIDC-generic boundary: realm_access.roles is in the
    // token but NOT surfaced in the user view.
    expect(auth.getUser()).not.toHaveProperty("realmRoles");
  });
});

describe("createOidcAuth — composed flow methods (with discovery)", () => {
  it("handleCallback fetches discovery, writes tokens to storage, returns user", async () => {
    // End-to-end-ish: proves the composition root binds discovery +
    // storage + config into the flow correctly.
    sessionStorage.setItem("pkce_state", "STATE");
    sessionStorage.setItem("pkce_verifier", "VERIFIER");
    const storage = makeStorage();
    const idToken =
      "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiJ1c2VyLWFiYy0xMjMiLCJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIn0." +
      "sig";

    vi.spyOn(globalThis, "fetch").mockImplementation(
      (url: string | URL | Request) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/.well-known/openid-configuration")) {
          return Promise.resolve(
            new Response(JSON.stringify(keycloakDoc(CONFIG.issuerUrl)), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "AT",
              refresh_token: "RT",
              id_token: idToken,
              expires_in: 300,
            }),
            { status: 200 },
          ),
        );
      },
    );

    const auth = createOidcAuth(CONFIG, { storage });
    const result = await auth.handleCallback(
      new URLSearchParams({ code: "c", state: "STATE" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.user.sub).toBe("user-abc-123");
    expect(auth.hasToken()).toBe(true);
    expect(auth.tokenProvider.getToken()).toBe("AT");
  });

  it("redirectToLogin awaits discovery before navigating", async () => {
    const fetchSpy = mockDiscovery();
    const auth = createOidcAuth(CONFIG);
    await auth.redirectToLogin();
    // Discovery must have been hit at least once.
    const wellKnown = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes("/.well-known/openid-configuration"),
    );
    expect(wellKnown).toBeDefined();
    // And the resulting authorize URL uses the discovered endpoint.
    expect(window.location.href).toContain(
      "https://auth.example.com/realms/demo/protocol/openid-connect/auth",
    );
  });

  it("handleCallback never throws on discovery failure (maps to exchange_failed/0)", async () => {
    // Regression: the original keycloak-browser handleCallback was
    // never-throw. Callback.tsx relies on the discriminated-union return
    // shape; an unhandled rejection here would leave the user stuck on
    // "Signing you in...". Discovery failure maps to the existing
    // `exchange_failed/0` variant — semantically "couldn't reach the
    // exchange".
    sessionStorage.setItem("pkce_state", "STATE");
    sessionStorage.setItem("pkce_verifier", "VERIFIER");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("idp dead", { status: 503 }),
    );
    const auth = createOidcAuth(CONFIG);
    const result = await auth.handleCallback(
      new URLSearchParams({ code: "c", state: "STATE" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.type).toBe("exchange_failed");
    if (result.error.type !== "exchange_failed") throw new Error("unreachable");
    expect(result.error.status).toBe(0);
  });

  it("prefetchMetadata warms the cache (one fetch shared by later calls)", async () => {
    const fetchSpy = mockDiscovery();
    const auth = createOidcAuth(CONFIG);
    await auth.prefetchMetadata();
    await auth.redirectToLogin();
    const wellKnownCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes("/.well-known/openid-configuration"),
    );
    // Module-level cache de-dupes — exactly one discovery fetch.
    expect(wellKnownCalls).toHaveLength(1);
  });
});

describe("createOidcAuth — tokenProvider", () => {
  it("getToken returns stored access token (even when expired)", () => {
    // CRITICAL: getToken must be dumb. The ws-client expects to send a
    // stale token, get 1008, then call refresh(). If getToken filtered
    // out expired tokens we'd skip the whole reconnect-then-refresh
    // path. Test reproduces an expired token on purpose.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const storage = makeStorage({
      accessToken: "STALE",
      refreshToken: "RT",
      idToken: "IT",
      expiresAt: Date.now() - 1,
    });
    const auth = createOidcAuth(CONFIG, { storage });
    expect(auth.tokenProvider.getToken()).toBe("STALE");
    vi.useRealTimers();
  });

  it("getToken returns null when no tokens stored", () => {
    const storage = makeStorage();
    const auth = createOidcAuth(CONFIG, { storage });
    expect(auth.tokenProvider.getToken()).toBeNull();
  });

  it("refresh returns the new access token and writes through to storage", async () => {
    const storage = makeStorage({
      accessToken: "old",
      refreshToken: "oldRT",
      idToken: "IT",
      expiresAt: Date.now() + 60_000,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (url: string | URL | Request) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/.well-known/openid-configuration")) {
          return Promise.resolve(
            new Response(JSON.stringify(keycloakDoc(CONFIG.issuerUrl)), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "newAT",
              refresh_token: "newRT",
              id_token: "newIT",
              expires_in: 300,
            }),
            { status: 200 },
          ),
        );
      },
    );
    const auth = createOidcAuth(CONFIG, { storage });
    const token = await auth.tokenProvider.refresh();
    expect(token).toBe("newAT");
    // Storage MUST have been updated; otherwise getToken() would keep
    // returning the stale value forever.
    expect(storage.writes.at(-1)?.accessToken).toBe("newAT");
  });

  it("refresh returns null when no refresh_token is stored", async () => {
    const storage = makeStorage();
    const auth = createOidcAuth(CONFIG, { storage });
    expect(await auth.tokenProvider.refresh()).toBeNull();
  });

  it("refresh dedupes concurrent in-flight calls", async () => {
    // Belt-and-suspenders for the ws-client + future-HTTP-transport race.
    // Two refresh() calls in the same tick must hit the network once.
    const storage = makeStorage({
      accessToken: "old",
      refreshToken: "oldRT",
      idToken: "IT",
      expiresAt: Date.now() + 60_000,
    });
    let tokenFetches = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (url: string | URL | Request) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/.well-known/openid-configuration")) {
          return Promise.resolve(
            new Response(JSON.stringify(keycloakDoc(CONFIG.issuerUrl)), {
              status: 200,
            }),
          );
        }
        tokenFetches += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "newAT",
              refresh_token: "newRT",
              id_token: "newIT",
              expires_in: 300,
            }),
            { status: 200 },
          ),
        );
      },
    );
    const auth = createOidcAuth(CONFIG, { storage });
    const [a, b] = await Promise.all([
      auth.tokenProvider.refresh(),
      auth.tokenProvider.refresh(),
    ]);
    expect(a).toBe("newAT");
    expect(b).toBe("newAT");
    expect(tokenFetches).toBe(1);
  });

  it("dedupe is released after a failed refresh (subsequent refresh re-fetches)", async () => {
    const storage = makeStorage({
      accessToken: "old",
      refreshToken: "oldRT",
      idToken: "IT",
      expiresAt: Date.now() + 60_000,
    });
    let tokenFetches = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (url: string | URL | Request) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/.well-known/openid-configuration")) {
          return Promise.resolve(
            new Response(JSON.stringify(keycloakDoc(CONFIG.issuerUrl)), {
              status: 200,
            }),
          );
        }
        tokenFetches += 1;
        if (tokenFetches === 1) {
          return Promise.resolve(new Response("expired", { status: 400 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "newAT",
              refresh_token: "newRT",
              id_token: "newIT",
              expires_in: 300,
            }),
            { status: 200 },
          ),
        );
      },
    );
    const auth = createOidcAuth(CONFIG, { storage });
    expect(await auth.tokenProvider.refresh()).toBeNull();
    expect(await auth.tokenProvider.refresh()).toBe("newAT");
    expect(tokenFetches).toBe(2);
  });
});

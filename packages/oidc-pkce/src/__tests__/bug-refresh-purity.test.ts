// bug-refresh-purity.test.ts — REGRESSION for CLAUDE.md "Auth flow contract".
//
// `TokenProvider.refresh()` MUST be pure:
//   - On failure: return null. Do NOT call `storage.clear()`. Do NOT
//     touch sessionStorage / PKCE state. Do NOT call the consumer's
//     onTerminalAuthFailure (the library owns that decision).
//   - On success: write the new tokens through to Storage. Without
//     the write, getToken() would keep returning the stale token
//     forever and the ws-client could never recover.
//
// The library's storm guard + onTerminalAuthFailure callback live in
// `@orpc-ws/client`, NOT here. If this test regresses, the bug
// is that the oidc-pkce package has started doing the cleanup
// itself, which would race the ws-client's own teardown and produce
// the "double-clear" foot-gun the source app already suffers from.
//
// File named `bug-refresh-purity.test.ts` so a grep on the convention
// surfaces it alongside other named-bug regressions in the monorepo.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { createOidcAuth } from "../client.js";
import { __resetMetadataCache } from "../discovery.js";
import type { OidcConfig, Storage, Tokens } from "../types.js";

const CONFIG: OidcConfig = {
  issuerUrl: "https://auth.example.com/realms/demo",
  clientId: "spa",
  redirectUri: "https://app.example.com/auth/callback",
};

function keycloakDoc(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
    token_endpoint: `${issuer}/protocol/openid-connect/token`,
    end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
    jwks_uri: `${issuer}/protocol/openid-connect/certs`,
  };
}

/**
 * Install a fetch mock that:
 *   - serves discovery from the in-memory Keycloak-shaped doc;
 *   - delegates all token-endpoint requests to `tokenHandler`.
 *
 * Returns the spy so callers can assert call counts on the token
 * endpoint specifically (discovery hits are noise for purity tests).
 */
function installFetchMock(
  tokenHandler: () => Response | Promise<Response>,
): ReturnType<typeof vi.spyOn> {
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
      return Promise.resolve(tokenHandler());
    });
}

function makeSpyStorage(initial: Tokens): Storage & {
  reads: number;
  writes: Tokens[];
  clears: number;
} {
  let value: Tokens | null = initial;
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
  sessionStorage.clear();
  localStorage.clear();
  __resetMetadataCache();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("regression: tokenProvider.refresh() is pure on failure", () => {
  it("returns null and does NOT call storage.clear() on a 400 from the IdP", async () => {
    const storage = makeSpyStorage({
      accessToken: "AT",
      refreshToken: "RT",
      idToken: "IT",
      expiresAt: Date.now() + 60_000,
    });
    installFetchMock(() => new Response("invalid_grant", { status: 400 }));
    const auth = createOidcAuth(CONFIG, { storage });

    const result = await auth.tokenProvider.refresh();

    expect(result).toBeNull();
    expect(storage.clears).toBe(0);
    // Storage must NOT have been written either (no partial update).
    expect(storage.writes).toEqual([]);
    // The stored token must still be readable; otherwise getToken()
    // would unexpectedly return null and the ws-client would think
    // the user is logged out.
    expect(auth.tokenProvider.getToken()).toBe("AT");
  });

  it("returns null and does NOT touch sessionStorage PKCE state on failure", async () => {
    // Plant a live PKCE state — this would happen if the user is mid-login
    // in another tab. A failed refresh in THIS tab must not clobber it.
    sessionStorage.setItem("pkce_state", "LIVE-STATE");
    sessionStorage.setItem("pkce_verifier", "LIVE-VERIFIER");

    const storage = makeSpyStorage({
      accessToken: "AT",
      refreshToken: "RT",
      idToken: "IT",
      expiresAt: Date.now() + 60_000,
    });
    installFetchMock(() => new Response("expired", { status: 400 }));
    const auth = createOidcAuth(CONFIG, { storage });

    await auth.tokenProvider.refresh();

    expect(sessionStorage.getItem("pkce_state")).toBe("LIVE-STATE");
    expect(sessionStorage.getItem("pkce_verifier")).toBe("LIVE-VERIFIER");
  });

  it("returns null and does NOT call storage.clear() on a network error", async () => {
    const storage = makeSpyStorage({
      accessToken: "AT",
      refreshToken: "RT",
      idToken: "IT",
      expiresAt: Date.now() + 60_000,
    });
    // For network-error coverage we install a discovery-only mock; the
    // token-endpoint handler throws.
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
        return Promise.reject(new Error("network down"));
      },
    );
    const auth = createOidcAuth(CONFIG, { storage });

    const result = await auth.tokenProvider.refresh();

    expect(result).toBeNull();
    expect(storage.clears).toBe(0);
    expect(storage.writes).toEqual([]);
  });

  it("returns null and does NOT call storage.clear() when no refresh_token is stored", async () => {
    // refresh() should bail before hitting the network; nothing to clear.
    const storage = makeSpyStorage({
      accessToken: "AT",
      refreshToken: "",
      idToken: "IT",
      expiresAt: Date.now() + 60_000,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const auth = createOidcAuth(CONFIG, { storage });

    const result = await auth.tokenProvider.refresh();

    expect(result).toBeNull();
    expect(storage.clears).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null on discovery failure and does NOT touch storage", async () => {
    // Discovery failure mid-refresh must NOT clear tokens — same purity
    // guarantee as the other failure paths. The ws-client storm guard
    // owns the give-up decision.
    const storage = makeSpyStorage({
      accessToken: "AT",
      refreshToken: "RT",
      idToken: "IT",
      expiresAt: Date.now() + 60_000,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("dead", { status: 503 }),
    );
    const auth = createOidcAuth(CONFIG, { storage });

    const result = await auth.tokenProvider.refresh();

    expect(result).toBeNull();
    expect(storage.clears).toBe(0);
    expect(storage.writes).toEqual([]);
    expect(auth.tokenProvider.getToken()).toBe("AT");
  });

  it("success path: writes new tokens to storage (purity does NOT forbid writes on success)", async () => {
    // The pure rule applies to the FAILURE path. On success we must
    // write through; this test pins that distinction so a future "fix"
    // doesn't over-correct and break the success branch.
    const storage = makeSpyStorage({
      accessToken: "old",
      refreshToken: "oldRT",
      idToken: "IT",
      expiresAt: Date.now() + 60_000,
    });
    installFetchMock(
      () =>
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
    const auth = createOidcAuth(CONFIG, { storage });

    const result = await auth.tokenProvider.refresh();

    expect(result).toBe("newAT");
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]?.accessToken).toBe("newAT");
    expect(storage.clears).toBe(0);
  });
});

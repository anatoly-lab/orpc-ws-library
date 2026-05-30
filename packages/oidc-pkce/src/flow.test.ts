// flow.test.ts — handleCallback branches + redirect side effects.
//
// happy-dom gives us a real `sessionStorage`, `localStorage`,
// `window.location`, and `URLSearchParams`. We mock `fetch` and the
// PKCE-state ordering is exercised explicitly per the spec.
//
// `handleCallback` / `redirectToLogin` / `logout` now take an
// already-resolved `OidcMetadata` rather than fetching it themselves.
// The discovery wiring lives in `client.ts`; these tests just provide
// the metadata bag directly.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { handleCallback, redirectToLogin, logout } from "./flow.js";
import type { OidcConfig, OidcMetadata, Storage, Tokens } from "./types.js";

const CONFIG: OidcConfig = {
  issuerUrl: "https://auth.example.com/realms/demo",
  clientId: "spa",
  redirectUri: "https://app.example.com/auth/callback",
};

// Keycloak-shaped metadata. This is the SAME shape the old
// `buildEndpoints(KeycloakConfig)` produced — so the assertions on
// authorize / token / endSession URLs below are an end-to-end COMPAT
// CHECK against the keycloak-browser package's hard-coded paths.
const KEYCLOAK_METADATA: OidcMetadata = {
  issuer: "https://auth.example.com/realms/demo",
  authorization_endpoint:
    "https://auth.example.com/realms/demo/protocol/openid-connect/auth",
  token_endpoint:
    "https://auth.example.com/realms/demo/protocol/openid-connect/token",
  end_session_endpoint:
    "https://auth.example.com/realms/demo/protocol/openid-connect/logout",
  jwks_uri:
    "https://auth.example.com/realms/demo/protocol/openid-connect/certs",
};

// In-memory Storage stub. Captures the most recently written bundle for
// assertions, never throws. Matches the Storage contract exactly.
function makeStorage(): Storage & { last: Tokens | null } {
  let value: Tokens | null = null;
  return {
    read: () => value,
    write: (t) => {
      value = t;
    },
    clear: () => {
      value = null;
    },
    get last() {
      return value;
    },
  };
}

// Plant a fresh PKCE pair into sessionStorage so the callback flow has
// something to read. The tests that exercise the `state_mismatch` branch
// skip this call.
function plantPkceState(state = "STATE", verifier = "VERIFIER"): void {
  sessionStorage.setItem("pkce_state", state);
  sessionStorage.setItem("pkce_verifier", verifier);
}

beforeEach(() => {
  // happy-dom keeps sessionStorage between tests; clear to avoid bleed.
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redirectToLogin", () => {
  it("stores PKCE state and navigates to the authorize endpoint (Keycloak compat)", async () => {
    // happy-dom's `window.location.href = ...` updates the location
    // synchronously and doesn't actually navigate. We just inspect it.
    await redirectToLogin(CONFIG, KEYCLOAK_METADATA);

    expect(sessionStorage.getItem("pkce_state")).not.toBeNull();
    expect(sessionStorage.getItem("pkce_verifier")).not.toBeNull();

    const url = window.location.href;
    // Compat: the URL prefix here is byte-identical to what the old
    // keycloak-browser package produced via `buildEndpoints`. If a
    // future Keycloak version changes the path shape and this assertion
    // breaks, the regression is in the realm config, not the library.
    expect(url).toContain(
      "https://auth.example.com/realms/demo/protocol/openid-connect/auth",
    );
    expect(url).toContain("response_type=code");
    expect(url).toContain("client_id=spa");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("scope=openid+email+profile");
  });

  it("honors custom scopes", async () => {
    await redirectToLogin(
      { ...CONFIG, scopes: ["openid", "offline_access"] },
      KEYCLOAK_METADATA,
    );
    expect(window.location.href).toContain("scope=openid+offline_access");
  });
});

describe("handleCallback — error branches", () => {
  it("returns state_mismatch when sessionStorage has no PKCE state", async () => {
    // No plantPkceState() — the storage is empty.
    const result = await handleCallback(
      new URLSearchParams({ code: "c", state: "S" }),
      CONFIG,
      KEYCLOAK_METADATA,
      makeStorage(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toEqual({ type: "state_mismatch" });
  });

  it("returns idp_error when ?error is present (after PKCE planted)", async () => {
    // Spec ordering: PKCE-presence check runs BEFORE ?error inspection.
    // So to exercise the idp_error branch we must plant valid state.
    plantPkceState();
    const result = await handleCallback(
      new URLSearchParams({
        error: "access_denied",
        error_description: "user said no",
      }),
      CONFIG,
      KEYCLOAK_METADATA,
      makeStorage(),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        type: "idp_error",
        error: "access_denied",
        description: "user said no",
      },
    });
    // PKCE state should be cleared — the flow is done.
    expect(sessionStorage.getItem("pkce_state")).toBeNull();
  });

  it("returns idp_error without description when error_description is absent", async () => {
    plantPkceState();
    const result = await handleCallback(
      new URLSearchParams({ error: "server_error" }),
      CONFIG,
      KEYCLOAK_METADATA,
      makeStorage(),
    );
    expect(result).toEqual({
      ok: false,
      error: { type: "idp_error", error: "server_error" },
    });
  });

  it("returns missing_code when ?code is absent and no error param", async () => {
    plantPkceState();
    const result = await handleCallback(
      new URLSearchParams({ state: "STATE" }),
      CONFIG,
      KEYCLOAK_METADATA,
      makeStorage(),
    );
    expect(result).toEqual({
      ok: false,
      error: { type: "missing_code" },
    });
  });

  it("returns state_mismatch when returned state differs from stored", async () => {
    plantPkceState("STORED", "VERIFIER");
    const result = await handleCallback(
      new URLSearchParams({ code: "c", state: "DIFFERENT" }),
      CONFIG,
      KEYCLOAK_METADATA,
      makeStorage(),
    );
    expect(result).toEqual({
      ok: false,
      error: { type: "state_mismatch" },
    });
  });

  it("returns exchange_failed when the token endpoint returns non-2xx", async () => {
    plantPkceState();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 400 }),
    );
    const result = await handleCallback(
      new URLSearchParams({ code: "c", state: "STATE" }),
      CONFIG,
      KEYCLOAK_METADATA,
      makeStorage(),
    );
    expect(result).toEqual({
      ok: false,
      error: { type: "exchange_failed", status: 400, body: "nope" },
    });
  });

  it("returns exchange_failed with status 0 on network failure", async () => {
    plantPkceState();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    const result = await handleCallback(
      new URLSearchParams({ code: "c", state: "STATE" }),
      CONFIG,
      KEYCLOAK_METADATA,
      makeStorage(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatchObject({
      type: "exchange_failed",
      status: 0,
    });
  });
});

describe("handleCallback — success", () => {
  it("writes tokens, clears PKCE state, and returns a user", async () => {
    plantPkceState();
    const storage = makeStorage();

    // Pinned id_token: sub=user-abc-123, email=alice@example.com.
    // Carries realm_access.roles but parseIdToken IGNORES it (OIDC-generic).
    const idToken =
      "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiJ1c2VyLWFiYy0xMjMiLCJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIiwibmFtZSI6IkFsaWNlIEV4YW1wbGUiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiJhbGljZSIsInJlYWxtX2FjY2VzcyI6eyJyb2xlcyI6WyJhZG1pbiIsInVzZXIiXX0sImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAzNjAwfQ." +
      "signature";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
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

    const result = await handleCallback(
      new URLSearchParams({ code: "c", state: "STATE" }),
      CONFIG,
      KEYCLOAK_METADATA,
      storage,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.user).toEqual({
      sub: "user-abc-123",
      email: "alice@example.com",
      name: "Alice Example",
      preferredUsername: "alice",
    });
    // OIDC-generic: realmRoles is NOT in the surface.
    expect(result.user).not.toHaveProperty("realmRoles");
    expect(storage.last?.accessToken).toBe("AT");
    expect(sessionStorage.getItem("pkce_state")).toBeNull();
    expect(sessionStorage.getItem("pkce_verifier")).toBeNull();
  });

  it("synthesizes a minimal user when id_token cannot be parsed", async () => {
    plantPkceState();
    const storage = makeStorage();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "AT",
          refresh_token: "RT",
          id_token: "garbage",
          expires_in: 300,
        }),
        { status: 200 },
      ),
    );
    const result = await handleCallback(
      new URLSearchParams({ code: "c", state: "STATE" }),
      CONFIG,
      KEYCLOAK_METADATA,
      storage,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.user.sub).toBe("unknown");
    expect(result.user).not.toHaveProperty("realmRoles");
  });
});

describe("logout", () => {
  it("clears storage and navigates to the end-session endpoint with id_token_hint", () => {
    const storage = makeStorage();
    storage.write({
      accessToken: "AT",
      refreshToken: "RT",
      idToken: "IT-hint",
      expiresAt: Date.now() + 1000,
    });

    logout(CONFIG, KEYCLOAK_METADATA, storage);

    expect(storage.last).toBeNull();
    const url = window.location.href;
    // Compat with the old keycloak-browser hard-coded path.
    expect(url).toContain(
      "https://auth.example.com/realms/demo/protocol/openid-connect/logout",
    );
    expect(url).toContain("id_token_hint=IT-hint");
    expect(url).toContain("client_id=spa");
  });

  it("uses the provided redirectTo", () => {
    const storage = makeStorage();
    logout(CONFIG, KEYCLOAK_METADATA, storage, {
      redirectTo: "https://app.example.com/bye",
    });
    expect(window.location.href).toContain(
      "post_logout_redirect_uri=https%3A%2F%2Fapp.example.com%2Fbye",
    );
  });

  it("defaults post_logout_redirect_uri to origin WITH trailing slash", () => {
    // Realms whitelist the SPA root as `https://app/` not bare-origin.
    // RFC 6749 mandates exact string match on redirect URIs; trailing slash
    // is load-bearing. Regression: bare-origin default broke logout against
    // a normally-configured Keycloak realm.
    const storage = makeStorage();
    window.location.href = "https://app.example.com/some/page";
    logout(CONFIG, KEYCLOAK_METADATA, storage);
    expect(window.location.href).toContain(
      "post_logout_redirect_uri=https%3A%2F%2Fapp.example.com%2F",
    );
  });

  it("omits id_token_hint when storage is empty", () => {
    const storage = makeStorage();
    // Reset the location so the previous test's URL doesn't leak.
    window.location.href = "https://app.example.com/";
    logout(CONFIG, KEYCLOAK_METADATA, storage);
    expect(window.location.href).not.toContain("id_token_hint");
  });

  it("clears local tokens and skips navigation when metadata has no end_session_endpoint", () => {
    // Some IdPs don't expose end_session_endpoint. logout() should still
    // clear local tokens; the consumer routes from there.
    const storage = makeStorage();
    storage.write({
      accessToken: "AT",
      refreshToken: "RT",
      idToken: "IT",
      expiresAt: Date.now() + 1000,
    });
    const before = window.location.href;
    const metadataNoEndSession: OidcMetadata = {
      ...KEYCLOAK_METADATA,
      end_session_endpoint: undefined,
    };
    logout(CONFIG, metadataNoEndSession, storage);
    expect(storage.last).toBeNull();
    // window.location.href should NOT have been reassigned to a
    // logout-endpoint URL — it stayed where the test set it.
    expect(window.location.href).toBe(before);
  });
});

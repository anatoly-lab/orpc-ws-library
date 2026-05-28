// tokens.test.ts — exchanges, JWT parse, expiry math.
//
// `vi.useFakeTimers({ toFake: ["Date"] })` is inherited from the vitest
// base config so `Date.now()` is deterministic inside `vi.setSystemTime`
// scopes. We don't fake setTimeout here — none of the code under test
// uses it.

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

import {
  exchangeCodeForTokens,
  isTokenExpired,
  parseIdToken,
  parseJwt,
  refreshTokens,
  tokenResponseToBundle,
} from "./tokens.js";
import type { OidcMetadata } from "./types.js";

// id_token fixture: header.payload(.sig). Payload has sub, email, name,
// preferred_username. (We INTENTIONALLY do NOT extract realm_access.roles
// — the package is OIDC-generic. The fixture still contains it because it
// matches the original Keycloak-shaped id_token, but parseIdToken ignores
// the field.)
const ID_TOKEN_FULL =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOiJ1c2VyLWFiYy0xMjMiLCJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIiwibmFtZSI6IkFsaWNlIEV4YW1wbGUiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiJhbGljZSIsInJlYWxtX2FjY2VzcyI6eyJyb2xlcyI6WyJhZG1pbiIsInVzZXIiXX0sImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAzNjAwfQ." +
  "signature";

const METADATA: OidcMetadata = {
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

describe("tokens", () => {
  describe("parseJwt", () => {
    it("decodes the payload of a 3-part JWT", () => {
      const payload = parseJwt(ID_TOKEN_FULL);
      expect(payload).not.toBeNull();
      expect(payload?.sub).toBe("user-abc-123");
      expect(payload?.email).toBe("alice@example.com");
    });

    it("returns null for a non-JWT string (no separators or empty)", () => {
      expect(parseJwt("not-a-jwt")).toBeNull();
      expect(parseJwt("")).toBeNull();
      expect(parseJwt("a..c")).toBeNull(); // empty payload
    });

    it("returns null when the payload isn't valid base64url/JSON", () => {
      expect(parseJwt("header.@@@.sig")).toBeNull();
      // "two" is not valid base64 padding, so atob throws.
      expect(parseJwt("only.two")).toBeNull();
    });
  });

  describe("parseIdToken", () => {
    it("extracts standard OIDC claims (sub, email, name, preferred_username)", () => {
      const user = parseIdToken(ID_TOKEN_FULL);
      expect(user).toEqual({
        sub: "user-abc-123",
        email: "alice@example.com",
        name: "Alice Example",
        preferredUsername: "alice",
      });
    });

    it("does NOT extract IdP-specific claims (realm_access.roles)", () => {
      // The fixture's payload contains `realm_access.roles = [admin, user]`
      // but the OIDC-generic OidcUser deliberately omits it. Consumers
      // who need IdP-specific claims call parseJwt themselves.
      const user = parseIdToken(ID_TOKEN_FULL);
      expect(user).not.toHaveProperty("realmRoles");
      expect(user).not.toHaveProperty("realm_access");
    });

    it("returns null when sub is missing", () => {
      // header.payload-with-no-sub.sig — payload = {"email":"a@b"}
      const noSub =
        "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9." +
        "eyJlbWFpbCI6ImFAYi5jb20ifQ." +
        "sig";
      expect(parseIdToken(noSub)).toBeNull();
    });

    it("returns null on a structurally invalid token", () => {
      expect(parseIdToken("garbage")).toBeNull();
    });
  });

  describe("isTokenExpired", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns false when expiresAt is in the future", () => {
      expect(
        isTokenExpired({
          accessToken: "x",
          refreshToken: "y",
          idToken: "z",
          expiresAt: Date.now() + 60_000,
        }),
      ).toBe(false);
    });

    it("returns true when expiresAt is in the past", () => {
      expect(
        isTokenExpired({
          accessToken: "x",
          refreshToken: "y",
          idToken: "z",
          expiresAt: Date.now() - 1,
        }),
      ).toBe(true);
    });

    it("returns true when expiresAt is exactly now", () => {
      expect(
        isTokenExpired({
          accessToken: "x",
          refreshToken: "y",
          idToken: "z",
          expiresAt: Date.now(),
        }),
      ).toBe(true);
    });
  });

  describe("tokenResponseToBundle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("converts a complete OIDC response into absolute-time Tokens", () => {
      const bundle = tokenResponseToBundle({
        access_token: "AT",
        refresh_token: "RT",
        id_token: "IT",
        expires_in: 300,
      });
      expect(bundle).toEqual({
        accessToken: "AT",
        refreshToken: "RT",
        idToken: "IT",
        expiresAt: Date.now() + 300_000,
      });
    });

    it("throws when refresh_token is missing", () => {
      expect(() =>
        tokenResponseToBundle({
          access_token: "AT",
          id_token: "IT",
          expires_in: 300,
        }),
      ).toThrow(/refresh_token/);
    });

    it("throws when id_token is missing", () => {
      expect(() =>
        tokenResponseToBundle({
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 300,
        }),
      ).toThrow(/id_token/);
    });

    it("defaults to a 5-minute expiry when expires_in is omitted", () => {
      const bundle = tokenResponseToBundle({
        access_token: "AT",
        refresh_token: "RT",
        id_token: "IT",
      });
      expect(bundle.expiresAt).toBe(Date.now() + 300_000);
    });
  });

  describe("exchangeCodeForTokens", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("POSTs to the token endpoint and parses the response", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "AT",
            refresh_token: "RT",
            id_token: "IT",
            expires_in: 600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const result = await exchangeCodeForTokens({
        metadata: METADATA,
        clientId: "spa",
        redirectUri: "https://app.example.com/auth/callback",
        code: "the-code",
        codeVerifier: "the-verifier",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable"); // narrow

      expect(result.tokens.accessToken).toBe("AT");
      // Sanity check the POST.
      const call = spy.mock.calls[0];
      if (!call) throw new Error("fetch not called");
      expect(call[0]).toBe(METADATA.token_endpoint);
      const init = call[1];
      expect(init?.method).toBe("POST");
      // Body should include the grant + code + verifier + client_id.
      const bodyStr = (init?.body as URLSearchParams).toString();
      expect(bodyStr).toContain("grant_type=authorization_code");
      expect(bodyStr).toContain("code=the-code");
      expect(bodyStr).toContain("code_verifier=the-verifier");
      expect(bodyStr).toContain("client_id=spa");
    });

    it("returns a structured error on non-2xx", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("invalid_grant", { status: 400 }),
      );
      const result = await exchangeCodeForTokens({
        metadata: METADATA,
        clientId: "spa",
        redirectUri: "https://app.example.com/auth/callback",
        code: "x",
        codeVerifier: "y",
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        body: "invalid_grant",
      });
    });
  });

  describe("refreshTokens", () => {
    const PRIOR = {
      accessToken: "oldAT",
      refreshToken: "oldRT",
      idToken: "oldIT",
      expiresAt: 0,
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns a fresh Tokens bundle on 2xx", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
      const result = await refreshTokens({
        metadata: METADATA,
        clientId: "spa",
        prior: PRIOR,
      });
      expect(result?.accessToken).toBe("newAT");
      expect(result?.refreshToken).toBe("newRT");
      expect(result?.idToken).toBe("newIT");
    });

    it("returns null on non-2xx", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("expired", { status: 400 }),
      );
      const result = await refreshTokens({
        metadata: METADATA,
        clientId: "spa",
        prior: PRIOR,
      });
      expect(result).toBeNull();
    });

    it("returns null on network failure", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
      const result = await refreshTokens({
        metadata: METADATA,
        clientId: "spa",
        prior: PRIOR,
      });
      expect(result).toBeNull();
    });

    it("falls back to prior refresh_token/id_token when omitted (rotation-disabled realms)", async () => {
      // Some IdP configs return access_token only on refresh.
      // We carry the prior refresh/id token through rather than treating
      // this as a terminal failure — matches the demo's tolerance and
      // avoids spurious onTerminalAuthFailure callbacks on first refresh.
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: "newAT", expires_in: 300 }),
          { status: 200 },
        ),
      );
      const result = await refreshTokens({
        metadata: METADATA,
        clientId: "spa",
        prior: PRIOR,
      });
      expect(result).not.toBeNull();
      expect(result?.accessToken).toBe("newAT");
      expect(result?.refreshToken).toBe("oldRT");
      expect(result?.idToken).toBe("oldIT");
    });

    it("returns null when the response lacks access_token entirely", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 }),
      );
      const result = await refreshTokens({
        metadata: METADATA,
        clientId: "spa",
        prior: PRIOR,
      });
      expect(result).toBeNull();
    });
  });
});

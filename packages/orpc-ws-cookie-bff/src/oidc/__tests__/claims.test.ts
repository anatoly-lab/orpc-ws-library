import { describe, expect, it } from "vitest";

import { decodeIdToken, decodeIdTokenClaims } from "../claims.js";

/** Build an unsigned JWT (header.payload.) from a payload object. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

describe("decodeIdTokenClaims (whitelist)", () => {
  it("decodes the standard claims including `picture` (F2)", () => {
    const claims = decodeIdTokenClaims(
      jwt({
        sub: "kc-1",
        email: "u@example.com",
        email_verified: true,
        name: "U Ser",
        given_name: "U",
        family_name: "Ser",
        preferred_username: "user",
        picture: "https://idp/avatar.png",
      }),
    );
    expect(claims).toEqual({
      sub: "kc-1",
      email: "u@example.com",
      emailVerified: true,
      name: "U Ser",
      givenName: "U",
      familyName: "Ser",
      preferredUsername: "user",
      picture: "https://idp/avatar.png",
    });
  });

  it("does NOT include non-whitelisted claims in the typed set", () => {
    const claims = decodeIdTokenClaims(
      jwt({ sub: "kc-1", custom_role: "admin", realm_access: { roles: ["a"] } }),
    );
    expect(claims).toEqual({ sub: "kc-1" });
    expect((claims as Record<string, unknown>).custom_role).toBeUndefined();
  });

  it("is safe on a null / malformed token", () => {
    expect(decodeIdTokenClaims(null)).toEqual({ sub: "" });
    expect(decodeIdTokenClaims("not-a-jwt")).toEqual({ sub: "" });
    expect(decodeIdTokenClaims("a.%%%.c")).toEqual({ sub: "" });
  });
});

describe("decodeIdToken (claims + raw, F2)", () => {
  it("surfaces the FULL raw payload so a consumer can read any claim", () => {
    const { claims, raw } = decodeIdToken(
      jwt({ sub: "kc-1", custom_role: "admin", picture: "https://idp/a.png" }),
    );
    // Typed claims = whitelist.
    expect(claims.sub).toBe("kc-1");
    expect(claims.picture).toBe("https://idp/a.png");
    // Raw = everything — including non-whitelisted claims.
    expect(raw.custom_role).toBe("admin");
    expect(raw.sub).toBe("kc-1");
  });

  it("returns `{ claims: { sub: '' }, raw: {} }` for a malformed token", () => {
    expect(decodeIdToken(null)).toEqual({ claims: { sub: "" }, raw: {} });
    expect(decodeIdToken("garbage")).toEqual({ claims: { sub: "" }, raw: {} });
  });

  it("treats a non-object JSON payload as malformed", () => {
    // A payload that parses to a string/number is not a claims object.
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const weird = `${b64({ alg: "none" })}.${b64("just-a-string")}.`;
    expect(decodeIdToken(weird)).toEqual({ claims: { sub: "" }, raw: {} });
  });
});

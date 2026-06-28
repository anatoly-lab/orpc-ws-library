import { describe, expect, it } from "vitest";

import {
  OAUTH_STATE_COOKIE,
  clearOAuthStateCookie,
  oauthStateMatches,
  serializeOAuthStateCookie,
} from "../oauth-state.js";

describe("serializeOAuthStateCookie", () => {
  it("is httpOnly, Secure, Lax by default with a short default Max-Age", () => {
    // Lax (NOT Strict) is the default: the state cookie rides a top-level GET
    // callback redirect that a cross-site login hop would otherwise withhold a
    // Strict cookie on (Decision #8, revised — see bug-21 regression test).
    const c = serializeOAuthStateCookie("state-123");
    expect(c).toContain(`${OAUTH_STATE_COOKIE}=state-123`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Max-Age=600");
  });

  it("can be set to Strict (verified same-registrable-site topology)", () => {
    const c = serializeOAuthStateCookie("s", { sameSite: "strict" });
    expect(c).toContain("SameSite=Strict");
  });

  it("can drop Secure for a localhost-http demo", () => {
    const c = serializeOAuthStateCookie("s", { secure: false });
    expect(c).not.toContain("Secure");
  });
});

describe("oauthStateMatches", () => {
  const header = serializeOAuthStateCookie("the-state").split(";")[0]!;

  it("matches a correct cookie/query pair", () => {
    expect(oauthStateMatches(header, "the-state")).toBe(true);
  });

  it("rejects a mismatched state", () => {
    expect(oauthStateMatches(header, "wrong")).toBe(false);
  });

  it("rejects when the cookie is absent", () => {
    expect(oauthStateMatches(undefined, "the-state")).toBe(false);
  });

  it("rejects when the query state is empty", () => {
    expect(oauthStateMatches(header, "")).toBe(false);
  });

  it("rejects a length-mismatched state without throwing (constant-time path)", () => {
    // Different lengths must short-circuit (timingSafeEqual would throw).
    expect(oauthStateMatches(header, "the-state-longer")).toBe(false);
  });
});

describe("clearOAuthStateCookie", () => {
  it("clears with Max-Age=0", () => {
    expect(clearOAuthStateCookie()).toContain("Max-Age=0");
  });
});

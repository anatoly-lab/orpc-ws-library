import { describe, expect, it } from "vitest";

import {
  OAUTH_STATE_COOKIE,
  clearOAuthStateCookie,
  oauthStateMatches,
  serializeOAuthStateCookie,
} from "../oauth-state.js";

describe("serializeOAuthStateCookie", () => {
  it("is httpOnly, Secure, Strict with a short default Max-Age", () => {
    const c = serializeOAuthStateCookie("state-123");
    expect(c).toContain(`${OAUTH_STATE_COOKIE}=state-123`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Max-Age=600");
  });

  it("can drop to Lax / non-secure (off-site IdP or localhost demo)", () => {
    const c = serializeOAuthStateCookie("s", { sameSite: "lax", secure: false });
    expect(c).toContain("SameSite=Lax");
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
